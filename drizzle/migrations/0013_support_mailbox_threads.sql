CREATE OR REPLACE FUNCTION public.is_support_operator() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'super_admin'); $$;
REVOKE ALL ON FUNCTION public.is_support_operator() FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.is_support_operator() TO authenticated,service_role;
CREATE TABLE public.support_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ticket_id uuid NOT NULL REFERENCES public.support_tickets(id),sender_id uuid NOT NULL,sender_kind text NOT NULL CHECK(sender_kind IN ('user','support')),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),created_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.support_messages TO authenticated; GRANT ALL ON public.support_messages TO service_role;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_read ON public.support_messages FOR SELECT TO authenticated USING(public.account_mfa_allowed() AND EXISTS(SELECT 1 FROM public.support_tickets t WHERE t.id=ticket_id AND (t.user_id=auth.uid() OR public.is_support_operator())));
CREATE INDEX support_message_thread ON public.support_messages(ticket_id,created_at);
CREATE TABLE public.mailbox_states(ticket_id uuid NOT NULL REFERENCES public.support_tickets(id),user_id uuid NOT NULL,starred boolean NOT NULL DEFAULT false,folder text NOT NULL DEFAULT 'inbox' CHECK(folder IN ('inbox','archive','trash')),read_at timestamptz,PRIMARY KEY(ticket_id,user_id));
GRANT SELECT,INSERT,UPDATE ON public.mailbox_states TO authenticated; GRANT ALL ON public.mailbox_states TO service_role;
ALTER TABLE public.mailbox_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY state_read ON public.mailbox_states FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE POLICY state_add ON public.mailbox_states FOR INSERT TO authenticated WITH CHECK(user_id=auth.uid() AND public.account_mfa_allowed() AND EXISTS(SELECT 1 FROM public.support_tickets t WHERE t.id=ticket_id AND (t.user_id=auth.uid() OR public.is_support_operator())));
CREATE POLICY state_edit ON public.mailbox_states FOR UPDATE TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed()) WITH CHECK(user_id=auth.uid() AND public.account_mfa_allowed() AND EXISTS(SELECT 1 FROM public.support_tickets t WHERE t.id=ticket_id AND (t.user_id=auth.uid() OR public.is_support_operator())));
CREATE TABLE public.support_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,subject text NOT NULL DEFAULT '' CHECK(length(subject)<=160),body text NOT NULL DEFAULT '' CHECK(length(body)<=4000),updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT,UPDATE,DELETE ON public.support_drafts TO authenticated; GRANT ALL ON public.support_drafts TO service_role;
ALTER TABLE public.support_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY draft_read ON public.support_drafts FOR SELECT TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE POLICY draft_add ON public.support_drafts FOR INSERT TO authenticated WITH CHECK(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE POLICY draft_edit ON public.support_drafts FOR UPDATE TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed()) WITH CHECK(user_id=auth.uid() AND public.account_mfa_allowed());
CREATE POLICY draft_delete ON public.support_drafts FOR DELETE TO authenticated USING(user_id=auth.uid() AND public.account_mfa_allowed());
INSERT INTO public.support_messages(ticket_id,sender_id,sender_kind,body,created_at) SELECT id,user_id,'user',message,created_at FROM public.support_tickets;
INSERT INTO public.support_messages(ticket_id,sender_id,sender_kind,body,created_at) SELECT id,user_id,'support',response,created_at FROM public.support_tickets WHERE response IS NOT NULL AND length(response)>0;
CREATE OR REPLACE FUNCTION public.capture_support_message() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE mid uuid; BEGIN
IF TG_OP='INSERT' THEN INSERT INTO public.support_messages(ticket_id,sender_id,sender_kind,body,created_at) VALUES(NEW.id,NEW.user_id,'user',NEW.message,NEW.created_at);
ELSIF NEW.response IS DISTINCT FROM OLD.response AND NEW.response IS NOT NULL AND length(NEW.response)>0 THEN
INSERT INTO public.support_messages(ticket_id,sender_id,sender_kind,body) VALUES(NEW.id,coalesce(auth.uid(),NEW.user_id),'support',NEW.response) RETURNING id INTO mid;
INSERT INTO public.notifications(user_id,title,body,kind,event_key) VALUES(NEW.user_id,'Support replied: '||NEW.subject,'A new reply is available in your private support mailbox.','support','support:'||mid) ON CONFLICT DO NOTHING;
END IF; RETURN NEW; END $$;
CREATE TRIGGER capture_support_thread AFTER INSERT OR UPDATE OF response ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.capture_support_message();
CREATE OR REPLACE FUNCTION public.mailbox_send(_ticket uuid,_subject text,_body text,_recipient text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE tid uuid; owner_id uuid; mid uuid; BEGIN
IF NOT public.account_mfa_allowed() THEN RAISE EXCEPTION 'Account verification required'; END IF;
IF _recipient<>'support' THEN RAISE EXCEPTION 'You can only message the support team'; END IF;
IF length(trim(_body)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'Message must contain 1 to 4000 characters'; END IF;
IF _ticket IS NULL THEN
IF length(trim(_subject)) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Subject must contain 1 to 160 characters'; END IF;
INSERT INTO public.support_tickets(user_id,subject,message,category) VALUES(auth.uid(),trim(_subject),trim(_body),'other') RETURNING id INTO tid;
ELSE
SELECT id,user_id INTO tid,owner_id FROM public.support_tickets WHERE id=_ticket FOR UPDATE;
IF tid IS NULL OR (owner_id<>auth.uid() AND NOT public.is_support_operator()) THEN RAISE EXCEPTION 'Conversation not found'; END IF;
INSERT INTO public.support_messages(ticket_id,sender_id,sender_kind,body) VALUES(tid,auth.uid(),CASE WHEN public.is_support_operator() AND owner_id<>auth.uid() THEN 'support' ELSE 'user' END,trim(_body)) RETURNING id INTO mid;
IF public.is_support_operator() AND owner_id<>auth.uid() THEN
UPDATE public.support_tickets SET status='in_progress' WHERE id=tid;
INSERT INTO public.notifications(user_id,title,body,kind,event_key) SELECT owner_id,'Support replied: '||subject,'A new reply is available in your private support mailbox.','support','support:'||mid FROM public.support_tickets WHERE id=tid;
ELSE UPDATE public.support_tickets SET status='open' WHERE id=tid;
END IF;
END IF;
INSERT INTO public.mailbox_states(ticket_id,user_id,read_at) VALUES(tid,auth.uid(),now()) ON CONFLICT(ticket_id,user_id) DO UPDATE SET read_at=now();
RETURN tid; END $$;
REVOKE ALL ON FUNCTION public.mailbox_send(uuid,text,text,text) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.mailbox_send(uuid,text,text,text) TO authenticated;
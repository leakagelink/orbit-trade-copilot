-- ROLLBACK for DRAFT 0047 (futures strategy attribution). DRAFT ONLY — never applied. Removes only objects 0047 created;
-- it does not touch public.orders, public.positions or public.trades. Run in ONE transaction. No CASCADE.
DROP VIEW public.futures_trade_strategy_attribution;
DROP FUNCTION public.claim_futures_order_strategy_identity(uuid, text, integer, text);
DROP TABLE public.futures_strategy_attribution_events;
DROP TABLE public.futures_order_strategy_identity;
DROP FUNCTION public.guard_futures_attribution_event();
DROP FUNCTION public.guard_futures_order_strategy_identity();
DROP FUNCTION public.futures_attribution_immutable();

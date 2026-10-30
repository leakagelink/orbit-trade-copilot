CREATE TABLE public.arbitrage_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL,
 request_key uuid NOT NULL UNIQUE,
 trading_pair text NOT NULL,
 buy_exchange text NOT NULL,
 sell_exchange text NOT NULL,
 buy_connection_id uuid REFERENCES public.exchange_connections(id),
 sell_connection_id uuid REFERENCES public.exchange_connections(id),
 mode text NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','live','testnet')),
 status text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','buy_filled','completed','blocked','needs_review')),
 budget numeric NOT NULL CHECK (budget > 0),
 estimated_net numeric,
 realized_net numeric,
 buy_fill jsonb,
 sell_fill jsonb,
 message text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (buy_exchange <> sell_exchange)
);
GRANT SELECT ON public.arbitrage_runs TO authenticated;
GRANT ALL ON public.arbitrage_runs TO service_role;
ALTER TABLE public.arbitrage_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Paid users read own arbitrage" ON public.arbitrage_runs FOR SELECT TO authenticated USING (auth.uid() = user_id AND public.has_pro_access(auth.uid()));
CREATE INDEX arbitrage_runs_user_created ON public.arbitrage_runs(user_id, created_at DESC);
CREATE UNIQUE INDEX arbitrage_one_active_per_user ON public.arbitrage_runs(user_id) WHERE status IN ('claimed','buy_filled','needs_review');
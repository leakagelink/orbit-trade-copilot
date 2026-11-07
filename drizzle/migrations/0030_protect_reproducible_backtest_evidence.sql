REVOKE INSERT,UPDATE,DELETE ON public.backtests FROM authenticated,anon;
REVOKE INSERT,UPDATE,DELETE ON public.backtest_results FROM authenticated,anon;
GRANT SELECT ON public.backtests,public.backtest_results TO authenticated;
GRANT ALL ON public.backtests,public.backtest_results TO service_role;
CREATE TRIGGER backtest_result_immutable BEFORE UPDATE OR DELETE ON public.backtest_results FOR EACH ROW EXECUTE FUNCTION public.prevent_evaluation_mutation();
COMMENT ON TABLE public.backtest_results IS 'Server-produced immutable simulator evidence; browser writes forbidden and independent evaluation replays the original manifest';
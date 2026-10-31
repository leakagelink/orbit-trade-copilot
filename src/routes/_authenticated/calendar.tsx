import {createFileRoute} from "@tanstack/react-router";
import {useEffect,useRef} from "react";
import {PageHeader} from "@/components/app-shell";
import {toolkitHead} from "@/components/toolkit-shared";
import {CalendarDays,ExternalLink} from "lucide-react";
import {Button} from "@/components/ui/button";
export const Route=createFileRoute("/_authenticated/calendar")({head:()=>toolkitHead("Economic calendar","Economic announcements and market events from TradingView."),component:Calendar});
function Calendar(){
 const ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{const el=ref.current;if(!el)return;const script=document.createElement("script");script.src="https://s3.tradingview.com/external-embedding/embed-widget-events.js";script.async=true;script.type="text/javascript";script.textContent=JSON.stringify({colorTheme:document.documentElement.classList.contains("dark")?"dark":"light",isTransparent:false,width:"100%",height:"650",locale:"en",importanceFilter:"-1,0,1",countryFilter:"us,eu,gb,jp,au,ca,ch,nz"});el.appendChild(script);return ()=>{el.replaceChildren();};},[]);
 return <div><PageHeader title="Economic calendar" description="Major announcements across global markets." actions={<CalendarDays className="h-6 w-6 text-primary"/>}/><div className="px-5 pb-8 md:px-7"><div className="tradingview-widget-container min-h-[650px] overflow-hidden rounded-md border"><div ref={ref} className="min-h-[650px]"><div className="tradingview-widget-container__widget"/></div></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Data by TradingView. Events and release times may change; this is not a trading signal.</p><Button variant="outline" asChild><a href="https://www.tradingview.com/economic-calendar/" target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4"/>TradingView calendar</a></Button></div></div></div>;
}
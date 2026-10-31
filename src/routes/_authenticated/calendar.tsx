import {createFileRoute} from "@tanstack/react-router";
import {useEffect,useState} from "react";
import {PageHeader} from "@/components/app-shell";
import {toolkitHead} from "@/components/toolkit-shared";
import {CalendarDays,ExternalLink} from "lucide-react";
import {Button} from "@/components/ui/button";
export const Route=createFileRoute("/_authenticated/calendar")({head:()=>toolkitHead("Economic calendar","Economic announcements and market events from TradingView."),component:Calendar});
function Calendar(){
 const [theme,setTheme]=useState("dark");
 useEffect(()=>{const sync=()=>setTheme(document.documentElement.classList.contains("dark")?"dark":"light");sync();const observer=new MutationObserver(sync);observer.observe(document.documentElement,{attributes:true,attributeFilter:["class"]});return()=>observer.disconnect();},[]);
 const config=JSON.stringify({colorTheme:theme,isTransparent:true,width:"100%",height:"650",locale:"en",importanceFilter:"-1,0,1",countryFilter:"us,eu,gb,jp,au,ca,ch,nz"});
 const documentHtml=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div><script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-events.js" async>${config}</script></div></body></html>`;
 return <div><PageHeader title="Economic calendar" description="Major announcements across global markets." actions={<CalendarDays className="h-6 w-6 text-primary"/>}/><div className="px-5 pb-8 md:px-7"><iframe title="TradingView economic calendar" srcDoc={documentHtml} sandbox="allow-scripts allow-popups" className="block h-[650px] w-full rounded-md border"/><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Data by TradingView. Events and release times may change; this is not a trading signal.</p><Button variant="outline" asChild><a href="https://www.tradingview.com/economic-calendar/" target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4"/>TradingView calendar</a></Button></div></div></div>;
}
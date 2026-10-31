import { useEffect, useState } from "react";

export type Lang = "en" | "hi";

const HI: Record<string, string> = {
  "/trade": "ट्रेड", "/wallet": "वॉलेट", "/dashboard": "डैशबोर्ड", "/assistant": "AI सहायक",
  "/strategies": "रणनीतियाँ", "/bots": "ट्रेडिंग बॉट", "/scalping": "स्कैल्पिंग", "/arbitrage": "आर्बिट्राज",
  "/backtests": "बैकटेस्ट", "/analytics": "विश्लेषण", "/risk": "जोखिम", "/exchanges": "एक्सचेंज",
  "/settings": "सेटिंग्स", "/plans": "प्लान", "/marketplace": "रणनीति बाज़ार", "/leaderboard": "डेमो लीडरबोर्ड",
  "/learn": "ट्रेडिंग सीखें", "/referrals": "दोस्तों को बुलाएँ", "/watchlist": "वॉचलिस्ट व अलर्ट",
  "/journal": "ट्रेडिंग जर्नल", "/calendar": "आर्थिक कैलेंडर", "/notifications": "सूचनाएँ", "/support": "सहायता",
  "/mailbox": "सपोर्ट मेलबॉक्स", "/status": "सेवा स्थिति", "/admin": "एडमिन पैनल",
};

export function navLabel(path: string, en: string, lang: Lang) {
  return lang === "hi" ? (HI[path] ?? en) : en;
}

const EVENT = "lang-change";
export function useLang(): [Lang, (l: Lang) => void] {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    const read = () => setLangState(localStorage.getItem("lang") === "hi" ? "hi" : "en");
    read();
    window.addEventListener(EVENT, read);
    return () => window.removeEventListener(EVENT, read);
  }, []);
  const setLang = (l: Lang) => { localStorage.setItem("lang", l); document.documentElement.lang = l; window.dispatchEvent(new Event(EVENT)); };
  return [lang, setLang];
}

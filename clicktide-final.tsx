import { useState, useEffect, useRef } from "react";

const SUPA_URL = "https://hmihfncvahsdlmefyxyg.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhtaWhmbmN2YWhzZGxtZWZ5eHlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1OTgzNDksImV4cCI6MjA5NjE3NDM0OX0.GP-4tYnKlNP9iSklJyXCSatz3I7gtQQJz7xOUQdXKWk";

const db = {
  async select(table, options={}, token) {
    let url=`${SUPA_URL}/rest/v1/${table}?select=*`;
    if(options.filter)url+=`&${options.filter}`;
    if(options.order)url+=`&order=${options.order}`;
    if(options.limit)url+=`&limit=${options.limit}`;
    const h={apikey:SUPA_KEY,Authorization:`Bearer ${token||SUPA_KEY}`,"Content-Type":"application/json"};
    const res=await fetch(url,{headers:h});
    if(!res.ok)throw new Error(await res.text());
    return res.json();
  },
  async insert(table,data,token){
    const res=await fetch(`${SUPA_URL}/rest/v1/${table}`,{method:"POST",headers:{apikey:SUPA_KEY,Authorization:`Bearer ${token||SUPA_KEY}`,"Content-Type":"application/json",Prefer:"return=representation"},body:JSON.stringify(data)});
    if(!res.ok)throw new Error(await res.text());
    return res.json();
  },
  async update(table,id,data,token){
    const res=await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`,{method:"PATCH",headers:{apikey:SUPA_KEY,Authorization:`Bearer ${token||SUPA_KEY}`,"Content-Type":"application/json",Prefer:"return=representation"},body:JSON.stringify(data)});
    if(!res.ok)throw new Error(await res.text());
    return res.json();
  },
  async delete(table,id,token){
    const res=await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`,{method:"DELETE",headers:{apikey:SUPA_KEY,Authorization:`Bearer ${token||SUPA_KEY}`}});
    if(!res.ok)throw new Error(await res.text());
    return true;
  },
};

const auth={
  async signUp(email,password,meta){
    const res=await fetch(`${SUPA_URL}/auth/v1/signup`,{method:"POST",headers:{apikey:SUPA_KEY,"Content-Type":"application/json"},body:JSON.stringify({email,password,data:meta})});
    const d=await res.json();if(d.error)throw new Error(d.error.message||d.msg);return d;
  },
  async signIn(email,password){
    const res=await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`,{method:"POST",headers:{apikey:SUPA_KEY,"Content-Type":"application/json"},body:JSON.stringify({email,password})});
    const d=await res.json();if(d.error)throw new Error(d.error.message||d.msg);return d;
  },
  async signOut(token){
    await fetch(`${SUPA_URL}/auth/v1/logout`,{method:"POST",headers:{apikey:SUPA_KEY,Authorization:`Bearer ${token}`}});
  },
};

const T={bg:"#080A0F",sur:"#0E1117",sur2:"#141820",bd:"rgba(255,255,255,0.08)",text:"#EEEAF4",mu:"rgba(238,234,244,0.45)",fa:"rgba(238,234,244,0.16)",am:"#FF5C00",amG:"rgba(255,92,0,0.12)",te:"#FF2D55",teG:"rgba(255,45,85,0.12)",sa:"#00C896",saG:"rgba(0,200,150,0.12)",bl:"#0066FF",blG:"rgba(0,102,255,0.12)",ro:"#FF2D55",roG:"rgba(255,45,85,0.12)",cy:"#00C8FF",cyG:"rgba(0,200,255,0.12)",vi:"#9B7FD4",viG:"rgba(155,127,212,0.12)"};
const F={d:"'Playfair Display',Georgia,serif",b:"'DM Sans',system-ui,sans-serif"};

const BIZS=[
  {id:"gym",label:"Gym & Fitness",icon:"💪",c:T.te,g:T.teG,platform:"Square / Mindbody",avgOrder:65,churn:0.18,churnDays:45,giftCost:7,giftName:"Water Bottle",lift:0.38,mCust:120},
  {id:"yoga",label:"Yoga & Wellness",icon:"🧘",c:T.sa,g:T.saG,platform:"Mindbody / Acuity",avgOrder:55,churn:0.15,churnDays:30,giftCost:6,giftName:"Bamboo Tumbler",lift:0.41,mCust:80},
  {id:"salon",label:"Salon & Spa",icon:"💆",c:T.ro,g:T.roG,platform:"Square / Vagaro",avgOrder:85,churn:0.22,churnDays:60,giftCost:8,giftName:"Skincare Set",lift:0.34,mCust:60},
  {id:"cafe",label:"Café & Coffee",icon:"☕",c:T.am,g:T.amG,platform:"Square / Toast",avgOrder:12,churn:0.25,churnDays:21,giftCost:5,giftName:"Travel Mug",lift:0.29,mCust:400},
  {id:"retail",label:"Local Retail",icon:"🛍️",c:T.bl,g:T.blG,platform:"Square / Lightspeed",avgOrder:45,churn:0.28,churnDays:90,giftCost:7,giftName:"Tote Bag",lift:0.31,mCust:150},
  {id:"resto",label:"Restaurant",icon:"🍽️",c:T.am,g:T.amG,platform:"Toast / Square",avgOrder:28,churn:0.30,churnDays:45,giftCost:5,giftName:"Branded Tumbler",lift:0.27,mCust:500},
  {id:"ecom",label:"E-commerce",icon:"🛒",c:T.vi,g:T.viG,platform:"Shopify / WooCommerce",avgOrder:75,churn:0.20,churnDays:90,giftCost:9,giftName:"Notebook",lift:0.35,mCust:200},
  {id:"saas",label:"SaaS / Tech",icon:"💻",c:T.cy,g:T.cyG,platform:"Stripe / Shopify",avgOrder:199,churn:0.08,churnDays:60,giftCost:12,giftName:"Premium Bottle",lift:0.44,mCust:50},
];
const PLATFORMS=[
  {id:"shopify",name:"Shopify",emoji:"🛒",c:T.sa,g:T.saG,desc:"E-commerce stores",triggers:["New customer","Order placed","Subscription","1-yr anniversary","Churn risk","Cart abandoned"]},
  {id:"square",name:"Square",emoji:"⬛",c:T.am,g:T.amG,desc:"Local & retail POS",triggers:["First purchase","5th visit","10th visit","Birthday","30-day inactive","Loyalty milestone"]},
  {id:"stripe",name:"Stripe",emoji:"💳",c:T.bl,g:T.blG,desc:"SaaS & online payments",triggers:["Subscription created","First payment","Plan upgraded","Annual renewal","Churn risk","Payment failed"]},
  {id:"clover",name:"Clover",emoji:"🍀",c:T.sa,g:T.saG,desc:"Restaurants & retail",triggers:["First visit","Loyalty earned","Birthday","60-day inactive","VIP tier","Special occasion"]},
  {id:"toast",name:"Toast",emoji:"🍞",c:T.am,g:T.amG,desc:"Restaurant POS",triggers:["First order","100th order","Birthday month","Seasonal","Loyalty milestone","Win-back"]},
  {id:"mindbody",name:"Mindbody",emoji:"🧘",c:T.ro,g:T.roG,desc:"Gyms, spas & salons",triggers:["First class","10-class milestone","Membership renewal","Birthday","Inactive 30 days","Package purchase"]},
];
const PLANS=[
  {name:"Local",price:29,color:T.sa,features:["200 customers/mo","3 trigger types","Square & Clover","Basic analytics","Email support"]},
  {name:"Growth",price:99,color:T.am,popular:true,features:["1,000 customers/mo","All trigger types","All 12 integrations","Retention analytics","Branded packaging","Priority support"]},
  {name:"Scale",price:299,color:T.bl,features:["Unlimited customers","AI triggers","White-label","A/B testing","Dedicated CSM","SLA guarantee"]},
];

const Logo=({s=22})=><div style={{fontFamily:F.d,fontSize:s,fontWeight:700}}>Click<span style={{color:T.am}}>tide</span></div>;
const Bdg=({l,c,g})=><span style={{background:g,color:c,padding:"3px 10px",borderRadius:100,fontSize:11,fontWeight:700,display:"inline-flex",alignItems:"center",gap:5}}><span style={{width:5,height:5,borderRadius:"50%",background:c}}></span>{l}</span>;
const SBdg=({st})=>{const m={active:{c:T.sa,g:T.saG,l:"Active"},paused:{c:T.am,g:T.amG,l:"Paused"},delivered:{c:T.sa,g:T.saG,l:"Delivered"},in_transit:{c:T.am,g:T.amG,l:"In Transit"},processing:{c:T.am,g:T.amG,l:"Processing"},live:{c:T.sa,g:T.saG,l:"Live"}};const s=m[st]||m.active;return<Bdg l={s.l} c={s.c} g={s.g}/>;};
const Spinner=()=><div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:40}}><div style={{width:32,height:32,border:`3px solid ${T.bd}`,borderTop:`3px solid ${T.am}`,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}></div></div>;
const Empty=({icon,title,sub,action,onAction})=><div style={{textAlign:"center",padding:"40px 24px",background:T.sur,border:`1px dashed ${T.bd}`,borderRadius:16}}><div style={{fontSize:36,marginBottom:10}}>{icon}</div><div style={{fontSize:15,fontWeight:700,marginBottom:5}}>{title}</div><div style={{fontSize:13,color:T.mu,marginBottom:16,lineHeight:1.6}}>{sub}</div>{action&&<button onClick={onAction} style={{background:T.am,color:"white",border:"none",padding:"9px 20px",borderRadius:100,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F.b}}>{action}</button>}</div>;
const Btn=({children,onClick,variant="primary",color,disabled,full,size="md"})=>{const p=size==="sm"?"7px 14px":"10px 20px";const styles={primary:{background:color||T.am,color:color?"white":"white"},secondary:{background:"rgba(255,255,255,0.06)",color:T.text,border:`1px solid ${T.bd}`},danger:{background:T.ro,color:"white"}};return<button onClick={onClick} disabled={disabled} style={{...styles[variant],border:"none",padding:p,borderRadius:100,fontSize:13,fontWeight:700,cursor:disabled?"not-allowed":"pointer",fontFamily:F.b,opacity:disabled?0.5:1,width:full?"100%":"auto",transition:"all 0.15s"}}>{children}</button>;};
const Inp=({label,value,onChange,placeholder,type="text",error})=><div style={{marginBottom:16}}>{label&&<label style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:T.mu,display:"block",marginBottom:7}}>{label}</label>}<input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={{width:"100%",padding:"11px 14px",borderRadius:10,border:`1px solid ${error?T.ro:T.bd}`,background:T.sur2,color:T.text,fontSize:14,outline:"none",fontFamily:F.b}}/>{error&&<div style={{fontSize:11,color:T.ro,marginTop:4}}>{error}</div>}</div>;
const Sel=({label,value,onChange,options})=><div style={{marginBottom:16}}>{label&&<label style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:T.mu,display:"block",marginBottom:7}}>{label}</label>}<select value={value} onChange={e=>onChange(e.target.value)} style={{width:"100%",padding:"11px 14px",borderRadius:10,border:`1px solid ${T.bd}`,background:T.sur2,color:T.text,fontSize:14,outline:"none",fontFamily:F.b}}>{options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></div>;
const Modal=({title,onClose,children})=><div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300,padding:20}}><div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:20,width:"100%",maxWidth:500,maxHeight:"88vh",overflow:"auto"}}><div style={{padding:"16px 22px",borderBottom:`1px solid ${T.bd}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}><div style={{fontSize:15,fontWeight:700}}>{title}</div><button onClick={onClose} style={{background:"transparent",border:"none",color:T.mu,fontSize:20,cursor:"pointer"}}>✕</button></div><div style={{padding:22}}>{children}</div></div></div>;

function useUp(target,dur=1200,active=true){const[v,setV]=useState(0);const r=useRef();useEffect(()=>{if(!active)return;const s=Date.now();cancelAnimationFrame(r.current);const t=()=>{const p=Math.min((Date.now()-s)/dur,1);setV(Math.round(target*(1-Math.pow(1-p,3))));if(p<1)r.current=requestAnimationFrame(t);};r.current=requestAnimationFrame(t);return()=>cancelAnimationFrame(r.current);},[target,active]);return v;}

function Landing({go,session}){
  const[email,setEmail]=useState("");const[ok,setOk]=useState(false);const[tick,setTick]=useState(0);
  const notifs=[{e:"📦",t:"Package delivered!",s:"Sarah M. received her welcome kit"},{e:"⬛",t:"Square connected!",s:"Pete's Barbershop — 3 triggers live"},{e:"📈",t:"Retention up 41%!",s:"Bloom Yoga after 60 days"},{e:"💳",t:"Stripe triggered!",s:"Nova SaaS — gift shipped"},{e:"🎉",t:"1,000th gift sent!",s:"All merchants this month"}];
  useEffect(()=>{const t=setInterval(()=>setTick(i=>(i+1)%notifs.length),3200);return()=>clearInterval(t);},[]);
  return(<div style={{fontFamily:F.b,background:T.bg,color:T.text,minHeight:"100vh"}}>
    <nav style={{position:"sticky",top:0,zIndex:100,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"15px 40px",background:"rgba(8,10,15,0.96)",backdropFilter:"blur(16px)",borderBottom:`1px solid ${T.bd}`}}>
      <Logo/>
      <div style={{display:"flex",gap:14,alignItems:"center"}}>
        {["Features","Pricing","Integrations"].map(l=><a key={l} href="#" style={{fontSize:13,color:T.mu,textDecoration:"none"}}>{l}</a>)}
        <button onClick={()=>go("roi")} style={{background:"transparent",border:`1px solid ${T.bd}`,color:T.mu,padding:"7px 16px",borderRadius:100,fontSize:13,cursor:"pointer",fontFamily:F.b}}>ROI Calculator</button>
        {session?<button onClick={()=>go("dash")} style={{background:T.am,color:"white",border:"none",padding:"9px 20px",borderRadius:100,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F.b}}>Dashboard →</button>:<><button onClick={()=>go("login")} style={{background:"transparent",border:`1px solid ${T.bd}`,color:T.text,padding:"9px 18px",borderRadius:100,fontSize:13,cursor:"pointer",fontFamily:F.b}}>Log in</button><button onClick={()=>go("signup")} style={{background:T.am,color:"white",border:"none",padding:"9px 20px",borderRadius:100,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F.b}}>Get started →</button></>}
      </div>
    </nav>
    <section style={{padding:"80px 40px 60px",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 80% 60% at 50% 20%, rgba(255,92,0,0.08) 0%, transparent 70%)"}}></div>
      <div style={{maxWidth:960,margin:"0 auto",position:"relative",textAlign:"center"}}>
        <div style={{display:"inline-flex",alignItems:"center",gap:8,background:T.amG,border:"1px solid rgba(255,92,0,0.3)",borderRadius:100,padding:"6px 16px",fontSize:11,fontWeight:700,color:T.am,textTransform:"uppercase",letterSpacing:0.5,marginBottom:22}}>
          <span style={{width:6,height:6,borderRadius:"50%",background:T.am,animation:"pulse 1.5s infinite"}}></span>Shopify · Square · Stripe · 12+ platforms
        </div>
        <h1 style={{fontFamily:F.d,fontSize:"clamp(40px,6vw,70px)",lineHeight:1.02,fontWeight:700,letterSpacing:-3,marginBottom:20}}>Send a gift.<br/><em style={{color:T.am}}>Start a tide.</em></h1>
        <p style={{fontSize:17,lineHeight:1.7,color:T.mu,maxWidth:480,margin:"0 auto 32px"}}>Clicktide automatically sends physical gifts when customers hit key milestones — turning churn into loyalty on autopilot.</p>
        <div style={{display:"flex",justifyContent:"center",gap:10,marginBottom:14}}>
          {!ok?<><input value={email} onChange={e=>setEmail(e.target.value)} placeholder="your@email.com" style={{padding:"13px 18px",borderRadius:100,border:`1px solid ${T.bd}`,background:"rgba(255,255,255,0.05)",color:T.text,fontSize:14,outline:"none",width:240,fontFamily:F.b}}/><button onClick={()=>email&&setOk(true)} style={{background:T.am,color:"white",border:"none",padding:"13px 24px",borderRadius:100,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:F.b}}>Join Waitlist</button></>:<div style={{padding:"13px 22px",background:T.saG,border:"1px solid rgba(0,200,150,0.25)",borderRadius:100,fontSize:14,color:T.sa,fontWeight:600}}>🎉 You're on the list!</div>}
        </div>
        <button onClick={()=>go("signup")} style={{background:"transparent",border:"none",color:T.am,fontSize:13,cursor:"pointer",fontFamily:F.b,textDecoration:"underline"}}>→ Start free trial — no credit card needed</button>
      </div>
      <div style={{display:"flex",justifyContent:"center",gap:8,flexWrap:"wrap",margin:"40px auto 0",maxWidth:900}}>
        {PLATFORMS.map(p=><div key={p.id} style={{padding:"6px 13px",background:T.sur,border:`1px solid ${T.bd}`,borderRadius:100,fontSize:12,color:T.mu,display:"flex",alignItems:"center",gap:5}}><span>{p.emoji}</span>{p.name}</div>)}
      </div>
      <div key={tick} style={{position:"fixed",bottom:20,right:20,background:T.sur,border:`1px solid ${T.bd}`,borderRadius:14,padding:"12px 16px",display:"flex",alignItems:"center",gap:10,boxShadow:"0 8px 32px rgba(0,0,0,0.5)",zIndex:50,maxWidth:280,animation:"fadeSlide 0.4s ease"}}>
        <span style={{fontSize:22}}>{notifs[tick].e}</span><div><div style={{fontSize:13,fontWeight:700}}>{notifs[tick].t}</div><div style={{fontSize:11,color:T.mu,marginTop:1}}>{notifs[tick].s}</div></div>
      </div>
    </section>
    <section style={{padding:"70px 40px",background:T.sur}}>
      <div style={{maxWidth:920,margin:"0 auto",textAlign:"center"}}>
        <h2 style={{fontFamily:F.d,fontSize:"clamp(28px,4vw,46px)",fontWeight:700,letterSpacing:-1.5,marginBottom:48}}>Live in <em style={{color:T.am}}>10 minutes.</em></h2>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14}}>
          {[{n:"01",i:"🔌",t:"Connect",d:"One-click OAuth on Square, Shopify, Stripe and 9 more platforms."},{n:"02",i:"⚡",t:"Set triggers",d:"First visit, birthday, churn risk — any customer milestone."},{n:"03",i:"🎁",t:"Design gift",d:"Upload logo, pick product, write a card. Printful ships it."},{n:"04",i:"📊",t:"Track ROI",d:"See exactly which gifts drive repeat visits and revenue."}].map(s=>(
            <div key={s.n} style={{background:T.bg,border:`1px solid ${T.bd}`,borderRadius:16,padding:20,textAlign:"left",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:-6,right:8,fontFamily:F.d,fontSize:64,fontWeight:700,color:"rgba(255,255,255,0.03)",lineHeight:1}}>{s.n}</div>
              <div style={{fontSize:26,marginBottom:10}}>{s.i}</div><div style={{fontSize:14,fontWeight:700,marginBottom:5}}>{s.t}</div><div style={{fontSize:12,lineHeight:1.7,color:T.mu}}>{s.d}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
    <section style={{padding:"70px 40px"}}>
      <div style={{maxWidth:860,margin:"0 auto",textAlign:"center"}}>
        <h2 style={{fontFamily:F.d,fontSize:"clamp(28px,4vw,46px)",fontWeight:700,letterSpacing:-1.5,marginBottom:14}}>Built for every <em style={{color:T.am}}>business size.</em></h2>
        <p style={{color:T.mu,fontSize:15,marginBottom:44}}>Subscription + pay-per-gift wallet. No surprise bills.</p>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
          {PLANS.map(pl=>(
            <div key={pl.name} style={{background:pl.popular?T.sur2:T.sur,border:`1px solid ${pl.popular?pl.color+"44":T.bd}`,borderRadius:18,padding:24,position:"relative",transform:pl.popular?"translateY(-6px)":"none"}}>
              {pl.popular&&<div style={{position:"absolute",top:-10,left:"50%",transform:"translateX(-50%)",background:pl.color,color:"white",padding:"3px 14px",borderRadius:100,fontSize:11,fontWeight:700}}>Most Popular</div>}
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:T.mu,marginBottom:6}}>{pl.name}</div>
              <div style={{fontFamily:F.d,fontSize:40,fontWeight:700,letterSpacing:-2,color:pl.color,marginBottom:3}}><sup style={{fontSize:18,verticalAlign:"super"}}>$</sup>{pl.price}</div>
              <div style={{fontSize:12,color:T.mu,marginBottom:16}}>/month + gift wallet</div>
              <div style={{height:1,background:T.bd,marginBottom:16}}></div>
              <ul style={{listStyle:"none",padding:0,display:"flex",flexDirection:"column",gap:8,textAlign:"left",marginBottom:18}}>
                {pl.features.map(f=><li key={f} style={{fontSize:12,display:"flex",gap:6,color:T.mu}}><span style={{color:T.sa,fontWeight:700,flexShrink:0}}>✓</span>{f}</li>)}
              </ul>
              <button onClick={()=>go("signup")} style={{display:"block",width:"100%",padding:11,borderRadius:100,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F.b,background:pl.popular?pl.color:"rgba(255,255,255,0.07)",color:"white",border:"none"}}>Get started →</button>
            </div>
          ))}
        </div>
      </div>
    </section>
    <section style={{padding:"60px 40px",background:T.sur}}>
      <div style={{maxWidth:860,margin:"0 auto",textAlign:"center"}}>
        <h2 style={{fontFamily:F.d,fontSize:"clamp(26px,4vw,44px)",fontWeight:700,letterSpacing:-1.5,marginBottom:14}}>The numbers speak <em style={{color:T.am}}>for themselves.</em></h2>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16,marginTop:40}}>
          {[["91%","Gift open rate","vs 21% email"],["3.2×","LTV increase","for gifted customers"],["↓34%","Churn reduction","average across all industries"],["14×","Average ROI","on every gift sent"]].map(([v,l,s])=>(
            <div key={l} style={{background:T.bg,border:`1px solid ${T.bd}`,borderRadius:16,padding:22,textAlign:"center"}}>
              <div style={{fontFamily:F.d,fontSize:36,fontWeight:700,color:T.am,marginBottom:6}}>{v}</div>
              <div style={{fontSize:13,fontWeight:700,marginBottom:4}}>{l}</div>
              <div style={{fontSize:11,color:T.mu}}>{s}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
    <section style={{padding:"60px 40px",textAlign:"center",borderTop:`1px solid ${T.bd}`}}>
      <h2 style={{fontFamily:F.d,fontSize:"clamp(26px,4vw,44px)",fontWeight:700,letterSpacing:-1.5,marginBottom:14}}>Ready to start the <em style={{color:T.am}}>tide?</em></h2>
      <p style={{color:T.mu,fontSize:15,marginBottom:28}}>Join hundreds of businesses keeping customers with Clicktide.</p>
      <div style={{display:"flex",justifyContent:"center",gap:10}}>
        <button onClick={()=>go("signup")} style={{background:T.am,color:"white",border:"none",padding:"14px 36px",borderRadius:100,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:F.b}}>Start free trial →</button>
        <button onClick={()=>go("roi")} style={{background:"transparent",border:`1px solid ${T.bd}`,color:T.mu,padding:"14px 26px",borderRadius:100,fontSize:15,cursor:"pointer",fontFamily:F.b}}>Calculate my ROI</button>
      </div>
    </section>
  </div>);
}

function AuthPage({go,mode,onAuth}){
  const isLogin=mode==="login";
  const[email,setEmail]=useState("");const[pass,setPass]=useState("");const[bizName,setBizName]=useState("");const[plan,setPlan]=useState("Growth");const[loading,setLoading]=useState(false);const[error,setError]=useState("");
  const submit=async()=>{
    setError("");if(!email||!pass)return setError("Please fill all fields");
    if(!isLogin&&!bizName)return setError("Please enter your business name");
    setLoading(true);
    try{
      let res;
      if(isLogin){res=await auth.signIn(email,pass);}
      else{res=await auth.signUp(email,pass,{business_name:bizName,plan});}
      if(res.access_token){
        localStorage.setItem("ct_token",res.access_token);
        localStorage.setItem("ct_user",JSON.stringify(res.user||{email}));
        onAuth(res.access_token,res.user||{email});
      } else {
        setError(isLogin?"Invalid email or password":"Check your email to confirm your account!");
      }
    }catch(e){setError(e.message);}
    setLoading(false);
  };
  return(
    <div style={{minHeight:"100vh",background:T.bg,color:T.text,fontFamily:F.b,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
      <div style={{marginBottom:28,cursor:"pointer"}} onClick={()=>go("land")}><Logo s={26}/></div>
      <div style={{width:"100%",maxWidth:420,background:T.sur,border:`1px solid ${T.bd}`,borderRadius:22,padding:32}}>
        <h2 style={{fontFamily:F.d,fontSize:26,fontWeight:700,marginBottom:6,textAlign:"center"}}>{isLogin?"Welcome back":"Start your free trial"}</h2>
        <p style={{fontSize:13,color:T.mu,textAlign:"center",marginBottom:28}}>{isLogin?"Log in to your Clicktide dashboard":"No credit card required · Cancel anytime"}</p>
        {!isLogin&&<Inp label="Business Name" value={bizName} onChange={setBizName} placeholder="Iron Forge Gym"/>}
        <Inp label="Email" value={email} onChange={setEmail} placeholder="you@business.com" type="email"/>
        <Inp label="Password" value={pass} onChange={setPass} placeholder="••••••••" type="password"/>
        {!isLogin&&<Sel label="Plan" value={plan} onChange={setPlan} options={[{value:"Local",label:"Local — $29/mo"},{value:"Growth",label:"Growth — $99/mo (Most Popular)"},{value:"Scale",label:"Scale — $299/mo"}]}/>}
        {error&&<div style={{background:T.teG,border:`1px solid ${T.te}44`,borderRadius:10,padding:"10px 14px",fontSize:13,color:T.te,marginBottom:16}}>{error}</div>}
        <button onClick={submit} disabled={loading} style={{width:"100%",padding:13,borderRadius:100,background:T.am,color:"white",border:"none",fontSize:14,fontWeight:700,cursor:loading?"not-allowed":"pointer",fontFamily:F.b,opacity:loading?0.7:1,marginBottom:16}}>
          {loading?(isLogin?"Logging in...":"Creating account..."):(isLogin?"Log in →":"Create my account →")}
        </button>
        <div style={{textAlign:"center",fontSize:13,color:T.mu}}>
          {isLogin?"Don't have an account? ":"Already have an account? "}
          <button onClick={()=>go(isLogin?"signup":"login")} style={{background:"transparent",border:"none",color:T.am,cursor:"pointer",fontFamily:F.b,fontWeight:700,fontSize:13,textDecoration:"underline"}}>
            {isLogin?"Sign up free":"Log in"}
          </button>
        </div>
      </div>
      <button onClick={()=>go("land")} style={{marginTop:18,background:"transparent",border:"none",color:T.mu,fontSize:13,cursor:"pointer",fontFamily:F.b}}>← Back to site</button>
    </div>
  );
}

function ROI({go}){
  const[step,setStep]=useState(0);const[biz,setBiz]=useState(null);const[ani,setAni]=useState(false);
  const[inp,setInp]=useState({nm:"",cust:100,aov:60,churn:0.20,days:60,gift:7,plan:99});
  const B=BIZS.find(b=>b.id===biz);
  const calc=()=>{if(!B)return null;const ch=Math.round(inp.cust*inp.churn);const lost=ch*inp.aov;const saved=Math.round(ch*B.lift);const rec=saved*inp.aov;const gs=saved*inp.gift;const netMo=rec-gs-inp.plan;const ag=netMo*12;const mult=Math.round((inp.aov/inp.gift)*10)/10;const netR=inp.aov-inp.gift;const pb=Math.max(1,Math.round((inp.plan+gs)/Math.max(rec,1)));const w=Array.from({length:12},(_,m)=>Math.round(inp.cust*inp.aov*Math.pow(1-inp.churn,m)));const r=Array.from({length:12},(_,m)=>Math.round(inp.cust*inp.aov*Math.pow(1-(inp.churn*(1-B.lift)),m)));return{ch,lost,al:lost*12,saved,rec,ag,mult,netR,pb,w,r};};
  const res=calc();const ag=useUp(res?.ag||0,1400,ani);const cs=useUp(res?.saved||0,1000,ani);const rm=useUp(res?.mult||0,1000,ani);
  const pick=(b)=>{setBiz(b.id);setInp(p=>({...p,cust:b.mCust,aov:b.avgOrder,churn:b.churn,days:b.churnDays,gift:b.giftCost}));};
  return(<div style={{minHeight:"100vh",background:T.bg,color:T.text,fontFamily:F.b}}>
    <header style={{padding:"14px 32px",borderBottom:`1px solid ${T.bd}`,display:"flex",alignItems:"center",justifyContent:"space-between",background:T.sur,position:"sticky",top:0,zIndex:10}}>
      <div style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer"}} onClick={()=>go("land")}><Logo/><div style={{width:1,height:18,background:T.bd}}></div><div style={{fontSize:13,color:T.mu}}>ROI Calculator</div></div>
      <button onClick={()=>go("land")} style={{background:"transparent",border:`1px solid ${T.bd}`,color:T.mu,padding:"7px 16px",borderRadius:100,fontSize:13,cursor:"pointer",fontFamily:F.b}}>← Back</button>
    </header>
    <div style={{maxWidth:880,margin:"0 auto",padding:"32px 20px"}}>
      {step===0&&(<div>
        <div style={{textAlign:"center",marginBottom:40}}>
          <h1 style={{fontFamily:F.d,fontSize:"clamp(32px,5vw,54px)",fontWeight:700,letterSpacing:-2,lineHeight:1.05,marginBottom:12}}>See exactly what<br/><em style={{color:T.am}}>Clicktide returns</em></h1>
          <p style={{fontSize:15,color:T.mu,maxWidth:440,margin:"0 auto",lineHeight:1.7}}>Pick your business type and we'll build a personalized diagram showing how a small gift turns into recovered revenue.</p>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
          {BIZS.map(b=>(<div key={b.id} onClick={()=>{pick(b);setStep(1);}} style={{padding:20,border:`1.5px solid ${T.bd}`,borderRadius:16,cursor:"pointer",background:T.sur,textAlign:"center",transition:"all 0.2s"}}>
            <div style={{fontSize:32,marginBottom:8}}>{b.icon}</div><div style={{fontSize:13,fontWeight:700,marginBottom:5}}>{b.label}</div>
            <div style={{fontSize:11,color:T.mu,marginBottom:10,lineHeight:1.4}}>{b.platform}</div>
            <div style={{fontSize:11,color:b.c,fontWeight:700}}>Avg {Math.round(b.lift*100)}% lift</div>
          </div>))}
        </div>
      </div>)}
      {step===1&&B&&(<div style={{maxWidth:560,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:24}}><div style={{fontSize:28,marginBottom:6}}>{B.icon}</div>
          <h2 style={{fontFamily:F.d,fontSize:30,fontWeight:700,letterSpacing:-1.5,marginBottom:6}}>About your <em style={{color:B.c}}>{B.label}</em></h2>
        </div>
        <div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:20,padding:28}}>
          <div style={{marginBottom:20}}><label style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:T.mu,display:"block",marginBottom:7}}>Business Name</label><input value={inp.nm} onChange={e=>setInp(p=>({...p,nm:e.target.value}))} placeholder="e.g. Iron Forge Gym" style={{width:"100%",padding:"11px 14px",borderRadius:10,border:`1px solid ${T.bd}`,background:T.sur2,color:T.text,fontSize:14,outline:"none",fontFamily:F.b}}/></div>
          {[{k:"cust",l:"Active customers/month",mn:10,mx:2000,st:10,pr:"",sf:" customers",pc:false},{k:"aov",l:"Average sale value",mn:5,mx:500,st:5,pr:"$",sf:"",pc:false},{k:"churn",l:"Monthly churn rate",mn:0.03,mx:0.50,st:0.01,pr:"",sf:"%",pc:true},{k:"days",l:"Days before churned",mn:14,mx:180,st:7,pr:"",sf:" days",pc:false},{k:"gift",l:"Gift cost per customer",mn:3,mx:50,st:1,pr:"$",sf:"",pc:false}].map(s=>(
            <div key={s.k} style={{marginBottom:18}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><div style={{fontSize:13,fontWeight:600}}>{s.l}</div><div style={{fontFamily:F.d,fontSize:18,fontWeight:700,color:B.c}}>{s.pr}{s.pc?Math.round(inp[s.k]*100):inp[s.k]}{s.sf}</div></div>
              <input type="range" min={s.mn} max={s.mx} step={s.st} value={inp[s.k]} onChange={e=>setInp(p=>({...p,[s.k]:parseFloat(e.target.value)}))} style={{width:"100%",accentColor:B.c}}/>
            </div>
          ))}
          <div style={{marginBottom:20}}>
            <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:T.mu,marginBottom:9}}>Retainly Plan</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7}}>
              {[{n:"Local",p:29},{n:"Growth",p:99},{n:"Scale",p:299}].map(pl=>(<div key={pl.p} onClick={()=>setInp(p=>({...p,plan:pl.p}))} style={{padding:"10px",border:`2px solid ${inp.plan===pl.p?B.c:T.bd}`,borderRadius:10,cursor:"pointer",background:inp.plan===pl.p?B.g:"transparent",textAlign:"center"}}>
                <div style={{fontSize:11,fontWeight:700,marginBottom:2}}>{pl.n}</div><div style={{fontFamily:F.d,fontSize:16,fontWeight:700,color:inp.plan===pl.p?B.c:T.text}}>${pl.p}<span style={{fontSize:10,color:T.mu}}>/mo</span></div>
              </div>))}
            </div>
          </div>
          {res&&<div style={{background:B.g,border:`1px solid ${B.c}33`,borderRadius:12,padding:14,marginBottom:16}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,textAlign:"center"}}>
              {[[res.saved,"Saved/mo",B.c],[`$${res.rec?.toLocaleString()}`,"Recovered",T.sa],[`${res.mult}×`,"ROI",T.am]].map(([v,l,c])=>(<div key={l}><div style={{fontFamily:F.d,fontSize:18,fontWeight:700,color:c}}>{v}</div><div style={{fontSize:11,color:T.mu}}>{l}</div></div>))}
            </div>
          </div>}
          <button onClick={()=>{setStep(2);setTimeout(()=>setAni(true),300);}} style={{width:"100%",padding:13,borderRadius:100,background:B.c,color:"white",border:"none",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:F.b}}>Show my retention diagram →</button>
        </div>
        <button onClick={()=>setStep(0)} style={{marginTop:12,background:"transparent",border:"none",color:T.mu,fontSize:13,cursor:"pointer",fontFamily:F.b,display:"block",width:"100%",textAlign:"center"}}>← Change type</button>
      </div>)}
      {step===2&&B&&res&&(<div>
        <div style={{textAlign:"center",marginBottom:28}}><div style={{fontSize:28,marginBottom:6}}>{B.icon}</div>
          <h2 style={{fontFamily:F.d,fontSize:"clamp(24px,4vw,40px)",fontWeight:700,letterSpacing:-1.5,marginBottom:6}}>{inp.nm||"Your business"}'s <em style={{color:B.c}}>Retention Diagram</em></h2>
          <p style={{fontSize:13,color:T.mu}}>{inp.cust} customers · ${inp.aov} avg order · ${inp.gift} gift</p>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:18}}>
          {[{l:"Annual gain",v:ani?`$${ag.toLocaleString()}`:"$0",s:"From retained customers",c:T.sa,g:T.saG},{l:"Customers saved/mo",v:ani?cs:0,s:`Of ${res.ch} churning`,c:B.c,g:B.g},{l:"Return per $1",v:ani?`${rm}×`:"0×",s:"Per gift",c:T.am,g:T.amG},{l:"Payback period",v:`${res.pb} mo`,s:"Until paid back",c:T.cy,g:T.cyG}].map(s=>(
            <div key={s.l} style={{background:s.g,border:`1px solid ${s.c}33`,borderRadius:14,padding:18,textAlign:"center"}}>
              <div style={{fontFamily:F.d,fontSize:26,fontWeight:700,color:s.c,marginBottom:4}}>{s.v}</div>
              <div style={{fontSize:11,fontWeight:700,marginBottom:3}}>{s.l}</div><div style={{fontSize:10,color:T.mu,lineHeight:1.5}}>{s.s}</div>
            </div>
          ))}
        </div>
        <div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:16,padding:20,marginBottom:14}}>
          <div style={{fontSize:13,fontWeight:700,marginBottom:14}}>How your ${inp.gift} gift works</div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4,flexWrap:"wrap"}}>
            {[{i:"👤",l:"Customer visits",s:`$${inp.aov}`,bg:B.g,b:B.c},{i:"⏰",l:`${inp.days} days`,s:"No return",bg:"rgba(255,255,255,0.03)",b:T.bd},{i:"🎁",l:`Gift $${inp.gift}`,s:B.giftName,bg:T.amG,b:T.am},{i:"🔁",l:"Returns",s:`$${inp.aov}`,bg:T.saG,b:T.sa},{i:"💰",l:`$${res.netR} profit`,s:`${res.mult}× ROI`,bg:T.saG,b:T.sa}].map((n,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center"}}><div style={{textAlign:"center",padding:"10px 12px",background:n.bg,border:`1.5px solid ${n.b}`,borderRadius:12,minWidth:88}}><div style={{fontSize:20,marginBottom:4}}>{n.i}</div><div style={{fontSize:11,fontWeight:700,marginBottom:2}}>{n.l}</div><div style={{fontSize:10,color:T.mu}}>{n.s}</div></div>{i<4&&<div style={{fontSize:14,color:T.mu,padding:"0 3px"}}>→</div>}</div>
            ))}
          </div>
        </div>
        <div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:16,padding:20,marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}><div style={{fontSize:13,fontWeight:700}}>12-Month Revenue Projection</div><div style={{display:"flex",gap:12}}>{[["rgba(255,255,255,0.15)","Without"],[B.c,"With Clicktide"]].map(([c,l])=><div key={l} style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:T.mu}}><div style={{width:10,height:3,background:c,borderRadius:2}}></div>{l}</div>)}</div></div>
          <div style={{display:"flex",alignItems:"flex-end",gap:3,height:100,marginBottom:5}}>
            {Array.from({length:12},(_,m)=>{const mx=Math.max(...res.r)*1.1;return(<div key={m} style={{flex:1,display:"flex",alignItems:"flex-end",gap:1}}><div style={{flex:1,background:"rgba(255,255,255,0.08)",borderRadius:"3px 3px 0 0",height:ani?(res.w[m]/mx*92):0,transition:`height 0.8s ease ${m*0.05}s`}}></div><div style={{flex:1,background:B.c,borderRadius:"3px 3px 0 0",height:ani?(res.r[m]/mx*92):0,transition:`height 0.8s ease ${m*0.05+0.1}s`,opacity:0.85}}></div></div>);})}
          </div>
          <div style={{display:"flex",gap:3}}>{Array.from({length:12},(_,m)=><div key={m} style={{flex:1,textAlign:"center",fontSize:9,color:T.fa}}>{"JFMAMJJASOND"[m]}</div>)}</div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:13,padding:16}}><div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:T.ro,marginBottom:10}}>❌ Without Clicktide</div>{[["Churned/mo",`${res.ch}`,T.ro],["Lost/mo",`$${res.lost.toLocaleString()}`,T.ro],["Annual loss",`$${res.al.toLocaleString()}`,T.ro]].map(([l,v,c])=>(<div key={l} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${T.bd}`}}><span style={{fontSize:12,color:T.mu}}>{l}</span><span style={{fontSize:13,fontWeight:700,color:c}}>{v}</span></div>))}</div>
          <div style={{background:T.saG,border:"1px solid rgba(0,200,150,0.2)",borderRadius:13,padding:16}}><div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:T.sa,marginBottom:10}}>✅ With Clicktide</div>{[["Saved/mo",`${res.saved}`,T.sa],["Recovered/mo",`$${res.rec.toLocaleString()}`,T.sa],["Annual gain",`$${res.ag.toLocaleString()}`,T.sa]].map(([l,v,c])=>(<div key={l} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid rgba(0,200,150,0.15)"}}><span style={{fontSize:12,color:T.mu}}>{l}</span><span style={{fontSize:13,fontWeight:700,color:c}}>{v}</span></div>))}</div>
        </div>
        <div style={{background:T.sur,border:`1px solid ${B.c}33`,borderRadius:14,padding:20,marginBottom:16}}>
          <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:B.c,marginBottom:8}}>💡 Key Insight</div>
          <div style={{fontSize:14,lineHeight:1.85,color:T.text}}>Right now, <strong style={{color:T.ro}}>{res.ch} customers</strong> leave monthly costing <strong style={{color:T.ro}}>${res.lost.toLocaleString()}/mo</strong>. A <strong style={{color:B.c}}>${inp.gift} {B.giftName}</strong> sent after <strong style={{color:B.c}}>{inp.days} days</strong> recovers <strong style={{color:T.sa}}>{res.saved} customers</strong> — turning a ${inp.gift} gift into <strong style={{color:T.am}}>${res.netR} net profit</strong>. Over 12 months that's <strong style={{color:T.sa}}>${res.ag.toLocaleString()}</strong> in recovered revenue.</div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <div style={{background:B.g,border:`1px solid ${B.c}33`,borderRadius:14,padding:22,textAlign:"center"}}><div style={{fontSize:24,marginBottom:6}}>🚀</div><div style={{fontFamily:F.d,fontSize:18,fontWeight:700,marginBottom:6}}>Start your free trial</div><div style={{fontSize:13,color:T.mu,marginBottom:14}}>No credit card required.</div><button onClick={()=>go("signup")} style={{width:"100%",padding:11,borderRadius:100,background:B.c,color:"white",border:"none",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F.b}}>Get started →</button></div>
          <div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:14,padding:22,textAlign:"center"}}><div style={{fontSize:24,marginBottom:6}}>🔄</div><div style={{fontFamily:F.d,fontSize:18,fontWeight:700,marginBottom:6}}>Try another type</div><div style={{fontSize:13,color:T.mu,marginBottom:14}}>See ROI for a different business.</div><button onClick={()=>{setStep(0);setAni(false);}} style={{width:"100%",padding:11,borderRadius:100,background:"rgba(255,255,255,0.06)",color:T.text,border:`1px solid ${T.bd}`,fontSize:13,cursor:"pointer",fontFamily:F.b}}>← Start over</button></div>
        </div>
      </div>)}
    </div>
  </div>);
}

function Dashboard({go,session,onLogout}){
  const[page,setPage]=useState("overview");const[showBuilder,setShowBuilder]=useState(false);
  const tok=session?.token||SUPA_KEY;
  const nav=[{id:"overview",i:"📊",l:"Overview"},{id:"customers",i:"👥",l:"Customers"},{id:"campaigns",i:"⚡",l:"Campaigns"},{id:"shipments",i:"📦",l:"Shipments"},{id:"wallet",i:"💳",l:"Wallet"},{id:"settings",i:"⚙️",l:"Settings"}];
  return(<div style={{display:"flex",height:"100vh",background:T.bg,color:T.text,fontFamily:F.b,overflow:"hidden"}}>
    {showBuilder&&<CampaignModal tok={tok} onClose={()=>setShowBuilder(false)} onSave={()=>setShowBuilder(false)}/>}
    <aside style={{width:210,background:T.sur,borderRight:`1px solid ${T.bd}`,display:"flex",flexDirection:"column",flexShrink:0}}>
      <div style={{padding:"16px 15px",borderBottom:`1px solid ${T.bd}`}}><Logo s={19}/><div style={{fontSize:10,color:T.sa,marginTop:2}}>● Live · Supabase connected</div></div>
      <nav style={{flex:1,padding:"10px 7px",display:"flex",flexDirection:"column",gap:2}}>
        {nav.map(n=><button key={n.id} onClick={()=>n.id==="giftbuilder"?setShowBuilder(true):setPage(n.id)} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:8,border:"none",background:page===n.id?T.amG:"transparent",color:page===n.id?T.am:T.mu,fontSize:12,fontWeight:page===n.id?700:400,cursor:"pointer",fontFamily:F.b,textAlign:"left",transition:"all 0.15s"}}><span style={{fontSize:14}}>{n.i}</span>{n.l}</button>)}
      </nav>
      <div style={{padding:"10px 7px",borderTop:`1px solid ${T.bd}`,display:"flex",flexDirection:"column",gap:4}}>
        {session?.user?.email&&<div style={{fontSize:10,color:T.fa,padding:"4px 10px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{session.user.email}</div>}
        <button onClick={()=>go("land")} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 10px",borderRadius:8,border:"none",background:"transparent",color:T.mu,fontSize:11,cursor:"pointer",fontFamily:F.b,width:"100%"}}>← Back to site</button>
        <button onClick={onLogout} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 10px",borderRadius:8,border:"none",background:T.roG,color:T.ro,fontSize:11,cursor:"pointer",fontFamily:F.b,width:"100%"}}>⏻ Log out</button>
      </div>
    </aside>
    <main style={{flex:1,overflow:"auto",padding:24}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
        <div><h1 style={{fontFamily:F.d,fontSize:20,fontWeight:700,marginBottom:2}}>{nav.find(n=>n.id===page)?.i} {nav.find(n=>n.id===page)?.l}</h1><div style={{fontSize:12,color:T.mu}}>Clicktide · Real data</div></div>
        <button onClick={()=>setShowBuilder(true)} style={{background:T.am,color:"white",border:"none",padding:"9px 18px",borderRadius:100,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F.b}}>+ New Campaign</button>
      </div>
      {page==="overview"&&<Overview tok={tok} onNew={()=>setShowBuilder(true)}/>}
      {page==="customers"&&<Customers tok={tok}/>}
      {page==="campaigns"&&<Campaigns tok={tok} onNew={()=>setShowBuilder(true)}/>}
      {page==="shipments"&&<Shipments tok={tok}/>}
      {page==="wallet"&&<Wallet tok={tok}/>}
      {page==="settings"&&<Settings tok={tok} session={session}/>}
    </main>
  </div>);
}

function Overview({tok,onNew}){
  const[stats,setStats]=useState({users:0,campaigns:0,shipments:0,wallet:0});const[campaigns,setCampaigns]=useState([]);const[shipments,setShipments]=useState([]);const[loading,setLoading]=useState(true);
  useEffect(()=>{Promise.all([db.select("clicktide",{},tok).catch(()=>[]),db.select("campaigns",{},tok).catch(()=>[]),db.select("shipments",{order:"created_at.desc",limit:5},tok).catch(()=>[]),db.select("wallet",{},tok).catch(()=>[])]).then(([u,c,s,w])=>{const bal=w.length?w[0].balance||0:0;setStats({users:u.length,campaigns:c.length,shipments:s.length,wallet:bal});setCampaigns(c.slice(0,4));setShipments(s);setLoading(false);});},[]);
  if(loading)return<Spinner/>;
  return(<div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:18}}>
      {[{l:"Businesses",v:stats.users,c:T.am},{l:"Campaigns",v:stats.campaigns,c:T.sa},{l:"Gifts Sent",v:stats.shipments,c:T.am},{l:"Wallet",v:`$${stats.wallet}`,c:T.cy}].map(s=>(<div key={s.l} style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:12,padding:14}}><div style={{fontSize:11,color:T.mu,marginBottom:5}}>{s.l}</div><div style={{fontFamily:F.d,fontSize:22,fontWeight:700,color:s.c}}>{s.v}</div></div>))}
    </div>
    <div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:13,padding:18,marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}><div style={{fontSize:13,fontWeight:700}}>Campaigns</div><button onClick={onNew} style={{background:"transparent",border:"none",color:T.am,fontSize:12,cursor:"pointer",fontFamily:F.b}}>+ New →</button></div>
      {campaigns.length===0?<Empty icon="⚡" title="No campaigns yet" sub="Create your first campaign." action="Create Campaign" onAction={onNew}/>:campaigns.map(c=>(<div key={c.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:`1px solid ${T.bd}`}}><div style={{width:32,height:32,borderRadius:8,background:T.amG,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15}}>🎁</div><div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>{c.name}</div><div style={{fontSize:11,color:T.mu}}>{c.trigger} · {c.gift_name}</div></div><SBdg st={c.status||"active"}/></div>))}
    </div>
    <div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:13,padding:18}}>
      <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>Recent Shipments</div>
      {shipments.length===0?<Empty icon="📦" title="No shipments yet" sub="Shipments appear when campaigns fire."/>:shipments.map(s=>(<div key={s.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`1px solid ${T.bd}`}}><div style={{width:30,height:30,borderRadius:7,background:T.amG,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>📦</div><div style={{flex:1}}><div style={{fontSize:12,fontWeight:600}}>{s.customer_name}</div><div style={{fontSize:11,color:T.mu}}>{s.gift}</div></div><SBdg st={s.status||"processing"}/></div>))}
    </div>
  </div>);
}

function Customers({tok}){
  const[customers,setCustomers]=useState([]);const[loading,setLoading]=useState(true);const[showModal,setShowModal]=useState(false);const[form,setForm]=useState({name:"",email:"",business_id:"",total_spent:"",status:"active"});const[saving,setSaving]=useState(false);
  const load=()=>{setLoading(true);db.select("customers",{order:"created_at.desc"},tok).then(d=>{setCustomers(d);setLoading(false);}).catch(()=>setLoading(false));};
  useEffect(()=>load(),[]);
  const save=async()=>{if(!form.name||!form.email)return;setSaving(true);try{await db.insert("customers",{name:form.name,email:form.email,business_id:form.business_id,total_spent:parseFloat(form.total_spent)||0,status:form.status},tok);setShowModal(false);setForm({name:"",email:"",business_id:"",total_spent:"",status:"active"});load();}catch(e){alert(e.message);}setSaving(false);};
  const remove=async(id)=>{if(!confirm("Delete?"))return;await db.delete("customers",id,tok);load();};
  if(loading)return<Spinner/>;
  return(<div>
    <div style={{display:"flex",justifyContent:"flex-end",marginBottom:14}}><Btn onClick={()=>setShowModal(true)}>+ Add Customer</Btn></div>
    {customers.length===0?<Empty icon="👥" title="No customers yet" sub="Add your first customer." action="Add Customer" onAction={()=>setShowModal(true)}/>:(
      <div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:12,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 120px 90px 60px",padding:"10px 14px",borderBottom:`1px solid ${T.bd}`,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:T.fa}}><span>Name</span><span>Email</span><span>Business</span><span>Spent</span><span>Status</span></div>
        {customers.map(c=>(<div key={c.id} style={{display:"grid",gridTemplateColumns:"1fr 1fr 120px 90px 60px",padding:"11px 14px",borderBottom:`1px solid ${T.bd}`,alignItems:"center"}}><div style={{fontSize:13,fontWeight:600}}>{c.name}</div><div style={{fontSize:12,color:T.mu}}>{c.email}</div><div style={{fontSize:12,color:T.mu}}>{c.business_id||"—"}</div><div style={{fontSize:13,fontWeight:600,color:T.sa}}>${c.total_spent||0}</div><div style={{display:"flex",alignItems:"center",gap:4}}><SBdg st={c.status||"active"}/><button onClick={()=>remove(c.id)} style={{background:"transparent",border:"none",color:T.ro,cursor:"pointer",fontSize:14,padding:0}}>×</button></div></div>))}
      </div>
    )}
    {showModal&&<Modal title="Add Customer" onClose={()=>setShowModal(false)}><Inp label="Full Name" value={form.name} onChange={v=>setForm(p=>({...p,name:v}))} placeholder="Sarah Mitchell"/><Inp label="Email" value={form.email} onChange={v=>setForm(p=>({...p,email:v}))} placeholder="sarah@example.com"/><Inp label="Business Name" value={form.business_id} onChange={v=>setForm(p=>({...p,business_id:v}))} placeholder="Iron Forge Gym"/><Inp label="Total Spent ($)" type="number" value={form.total_spent} onChange={v=>setForm(p=>({...p,total_spent:v}))} placeholder="0"/><Sel label="Status" value={form.status} onChange={v=>setForm(p=>({...p,status:v}))} options={[{value:"active",label:"Active"},{value:"inactive",label:"Inactive"},{value:"churned",label:"Churned"}]}/><div style={{display:"flex",gap:10,marginTop:8}}><Btn onClick={save} disabled={saving} full>{saving?"Saving...":"Save Customer"}</Btn><Btn variant="secondary" onClick={()=>setShowModal(false)}>Cancel</Btn></div></Modal>}
  </div>);
}

function Campaigns({tok,onNew}){
  const[campaigns,setCampaigns]=useState([]);const[loading,setLoading]=useState(true);
  const load=()=>{setLoading(true);db.select("campaigns",{order:"created_at.desc"},tok).then(d=>{setCampaigns(d);setLoading(false);}).catch(()=>setLoading(false));};
  useEffect(()=>load(),[]);
  const remove=async(id)=>{if(!confirm("Delete?"))return;await db.delete("campaigns",id,tok);load();};
  const toggle=async(c)=>{await db.update("campaigns",c.id,{status:c.status==="active"?"paused":"active"},tok);load();};
  if(loading)return<Spinner/>;
  return(<div>
    {campaigns.length===0?<Empty icon="⚡" title="No campaigns yet" sub="Create your first gift campaign." action="Create Campaign" onAction={onNew}/>:(
      <div style={{display:"flex",flexDirection:"column",gap:11}}>
        {campaigns.map(c=>(<div key={c.id} style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:12,padding:16,display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:40,height:40,borderRadius:10,background:T.amG,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🎁</div>
          <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3}}><div style={{fontSize:13,fontWeight:700}}>{c.name}</div><SBdg st={c.status||"active"}/></div><div style={{fontSize:12,color:T.mu}}>Trigger: {c.trigger} · Gift: {c.gift_name} · ${c.gift_cost} · {c.platform}</div></div>
          <div style={{display:"flex",gap:7}}>
            <button onClick={()=>toggle(c)} style={{background:"rgba(255,255,255,0.05)",border:`1px solid ${T.bd}`,color:T.text,padding:"6px 11px",borderRadius:8,fontSize:11,cursor:"pointer",fontFamily:F.b}}>{c.status==="active"?"Pause":"Resume"}</button>
            <button onClick={()=>remove(c.id)} style={{background:T.roG,border:`1px solid ${T.ro}44`,color:T.ro,padding:"6px 11px",borderRadius:8,fontSize:11,cursor:"pointer",fontFamily:F.b}}>Delete</button>
          </div>
        </div>))}
      </div>
    )}
  </div>);
}

function Shipments({tok}){
  const[shipments,setShipments]=useState([]);const[loading,setLoading]=useState(true);const[showModal,setShowModal]=useState(false);const[form,setForm]=useState({customer_name:"",gift:"",campaign:"",platform:"",status:"processing",tracking:""});const[saving,setSaving]=useState(false);
  const load=()=>{setLoading(true);db.select("shipments",{order:"created_at.desc"},tok).then(d=>{setShipments(d);setLoading(false);}).catch(()=>setLoading(false));};
  useEffect(()=>load(),[]);
  const save=async()=>{if(!form.customer_name||!form.gift)return;setSaving(true);try{await db.insert("shipments",form,tok);setShowModal(false);setForm({customer_name:"",gift:"",campaign:"",platform:"",status:"processing",tracking:""});load();}catch(e){alert(e.message);}setSaving(false);};
  if(loading)return<Spinner/>;
  return(<div>
    <div style={{display:"flex",justifyContent:"flex-end",marginBottom:14}}><Btn onClick={()=>setShowModal(true)}>+ Add Shipment</Btn></div>
    {shipments.length===0?<Empty icon="📦" title="No shipments yet" sub="Shipments appear automatically when campaigns fire."/>:(
      <div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:12,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 100px 110px",padding:"10px 14px",borderBottom:`1px solid ${T.bd}`,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:T.fa}}><span>Customer</span><span>Gift · Campaign</span><span>Platform</span><span>Status</span></div>
        {shipments.map(s=>(<div key={s.id} style={{display:"grid",gridTemplateColumns:"1fr 1fr 100px 110px",padding:"11px 14px",borderBottom:`1px solid ${T.bd}`,alignItems:"center"}}><div style={{fontSize:12,fontWeight:600}}>{s.customer_name}</div><div><div style={{fontSize:12}}>{s.gift}</div><div style={{fontSize:10,color:T.mu}}>{s.campaign}</div></div><div style={{fontSize:11,color:T.mu}}>{s.platform||"—"}</div><SBdg st={s.status||"processing"}/></div>))}
      </div>
    )}
    {showModal&&<Modal title="Add Shipment" onClose={()=>setShowModal(false)}><Inp label="Customer Name" value={form.customer_name} onChange={v=>setForm(p=>({...p,customer_name:v}))} placeholder="Sarah Mitchell"/><Inp label="Gift" value={form.gift} onChange={v=>setForm(p=>({...p,gift:v}))} placeholder="Branded Water Bottle"/><Inp label="Campaign" value={form.campaign} onChange={v=>setForm(p=>({...p,campaign:v}))} placeholder="Welcome Kit"/><Inp label="Platform" value={form.platform} onChange={v=>setForm(p=>({...p,platform:v}))} placeholder="Square"/><Inp label="Tracking Number" value={form.tracking} onChange={v=>setForm(p=>({...p,tracking:v}))} placeholder="1Z999AA10123456784"/><Sel label="Status" value={form.status} onChange={v=>setForm(p=>({...p,status:v}))} options={[{value:"processing",label:"Processing"},{value:"in_transit",label:"In Transit"},{value:"delivered",label:"Delivered"}]}/><div style={{display:"flex",gap:10,marginTop:8}}><Btn onClick={save} disabled={saving} full>{saving?"Saving...":"Save Shipment"}</Btn><Btn variant="secondary" onClick={()=>setShowModal(false)}>Cancel</Btn></div></Modal>}
  </div>);
}

function Wallet({tok}){
  const[transactions,setTransactions]=useState([]);const[balance,setBalance]=useState(0);const[loading,setLoading]=useState(true);const[showModal,setShowModal]=useState(false);const[form,setForm]=useState({desc:"",amount:"",gift:""});const[saving,setSaving]=useState(false);
  const load=()=>{setLoading(true);db.select("wallet",{order:"created_at.desc"},tok).then(d=>{setTransactions(d);if(d.length)setBalance(d[0].balance||0);setLoading(false);}).catch(()=>setLoading(false));};
  useEffect(()=>load(),[]);
  const save=async()=>{if(!form.desc||!form.amount)return;setSaving(true);const amt=parseFloat(form.amount);const newBal=balance+amt;try{await db.insert("wallet",{desc:form.desc,gift:form.gift||null,amount:amt,balance:newBal},tok);setShowModal(false);setForm({desc:"",amount:"",gift:""});load();}catch(e){alert(e.message);}setSaving(false);};
  if(loading)return<Spinner/>;
  return(<div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:16}}>
      <div style={{background:T.amG,border:"1px solid rgba(255,92,0,0.25)",borderRadius:14,padding:20}}><div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:T.am,marginBottom:8}}>Gift Wallet</div><div style={{fontFamily:F.d,fontSize:36,fontWeight:700,color:T.am,marginBottom:6}}>${balance.toFixed(2)}</div><div style={{fontSize:12,color:T.mu,marginBottom:12}}>Available for gifts</div><Btn onClick={()=>{setForm({desc:"Top-up",amount:"",gift:""});setShowModal(true);}}>Add Funds</Btn></div>
      <div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:14,padding:20}}><div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,color:T.mu,marginBottom:10}}>Quick Stats</div>{[["Transactions",transactions.length],["Total spent",`$${transactions.filter(t=>t.amount<0).reduce((a,t)=>a+Math.abs(t.amount),0).toFixed(2)}`],["Total added",`$${transactions.filter(t=>t.amount>0).reduce((a,t)=>a+t.amount,0).toFixed(2)}`]].map(([l,v])=>(<div key={l} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${T.bd}`}}><span style={{fontSize:12,color:T.mu}}>{l}</span><span style={{fontSize:13,fontWeight:700}}>{v}</span></div>))}</div>
    </div>
    <div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:13,padding:18}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}><div style={{fontSize:13,fontWeight:700}}>Transaction History</div><Btn variant="secondary" size="sm" onClick={()=>setShowModal(true)}>+ Add</Btn></div>
      {transactions.length===0?<Empty icon="💳" title="No transactions yet" sub="Add funds to start sending gifts."/>:(<>{transactions.map(tx=>(<div key={tx.id} style={{display:"grid",gridTemplateColumns:"1fr 70px 80px",padding:"10px 0",borderBottom:`1px solid ${T.bd}`,alignItems:"center"}}><div><div style={{fontSize:12,fontWeight:600}}>{tx.desc}</div>{tx.gift&&<div style={{fontSize:10,color:T.mu}}>{tx.gift}</div>}</div><div style={{fontSize:12,fontWeight:700,color:tx.amount>0?T.sa:T.ro,textAlign:"right"}}>{tx.amount>0?"+$"+tx.amount:"-$"+Math.abs(tx.amount)}</div><div style={{fontSize:12,fontWeight:600,textAlign:"right"}}>${tx.balance}</div></div>))}</>)}
    </div>
    {showModal&&<Modal title="Add Transaction" onClose={()=>setShowModal(false)}><Inp label="Description" value={form.desc} onChange={v=>setForm(p=>({...p,desc:v}))} placeholder="Top-up / Gift sent to Sarah"/><Inp label="Amount (+ to add, - to spend)" type="number" value={form.amount} onChange={v=>setForm(p=>({...p,amount:v}))} placeholder="200 or -21"/><Inp label="Gift (optional)" value={form.gift} onChange={v=>setForm(p=>({...p,gift:v}))} placeholder="Branded Water Bottle"/><div style={{display:"flex",gap:10,marginTop:8}}><Btn onClick={save} disabled={saving} full>{saving?"Saving...":"Save"}</Btn><Btn variant="secondary" onClick={()=>setShowModal(false)}>Cancel</Btn></div></Modal>}
  </div>);
}

function Settings({tok,session}){
  const[businesses,setBusinesses]=useState([]);const[loading,setLoading]=useState(true);const[showModal,setShowModal]=useState(false);const[form,setForm]=useState({email:"",business_name:"",plan:"Growth"});const[saving,setSaving]=useState(false);
  const load=()=>{setLoading(true);db.select("clicktide",{order:"created_at.desc"},tok).then(d=>{setBusinesses(d);setLoading(false);}).catch(()=>setLoading(false));};
  useEffect(()=>load(),[]);
  const save=async()=>{if(!form.email||!form.business_name)return;setSaving(true);try{await db.insert("clicktide",form,tok);setShowModal(false);setForm({email:"",business_name:"",plan:"Growth"});load();}catch(e){alert(e.message);}setSaving(false);};
  const remove=async(id)=>{if(!confirm("Remove?"))return;await db.delete("clicktide",id,tok);load();};
  if(loading)return<Spinner/>;
  return(<div>
    <div style={{background:T.saG,border:"1px solid rgba(0,200,150,0.2)",borderRadius:12,padding:16,marginBottom:16,display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:22}}>✅</span><div><div style={{fontSize:13,fontWeight:700,color:T.sa}}>Supabase Connected</div><div style={{fontSize:11,color:T.mu}}>{SUPA_URL}</div></div></div>
    {session?.user?.email&&<div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:12,padding:16,marginBottom:16,display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:22}}>👤</span><div><div style={{fontSize:13,fontWeight:700}}>Logged in as</div><div style={{fontSize:11,color:T.mu}}>{session.user.email}</div></div></div>}
    <div style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:13,padding:18,marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}><div style={{fontSize:13,fontWeight:700}}>Registered Businesses</div><Btn onClick={()=>setShowModal(true)}>+ Add</Btn></div>
      {businesses.length===0?<Empty icon="🏢" title="No businesses yet" sub="Add your first business." action="Add Business" onAction={()=>setShowModal(true)}/>:businesses.map(b=>(<div key={b.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:`1px solid ${T.bd}`}}><div style={{width:32,height:32,borderRadius:8,background:T.amG,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15}}>🏢</div><div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>{b.business_name}</div><div style={{fontSize:11,color:T.mu}}>{b.email} · {b.plan} Plan</div></div><Bdg l={b.plan} c={T.am} g={T.amG}/><button onClick={()=>remove(b.id)} style={{background:"transparent",border:"none",color:T.ro,cursor:"pointer",fontSize:16,padding:0}}>×</button></div>))}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      {[{i:"📦",t:"Printful",d:"Connect to ship gifts automatically"},{i:"💳",t:"Stripe",d:"Connect to accept payments"},{i:"⬛",t:"Square",d:"Connect to track customer visits"},{i:"📧",t:"Resend",d:"Connect to send notification emails"}].map(item=>(<div key={item.t} style={{background:T.sur,border:`1px solid ${T.bd}`,borderRadius:11,padding:14,display:"flex",alignItems:"center",gap:9}}><span style={{fontSize:20}}>{item.i}</span><div style={{flex:1}}><div style={{fontSize:12,fontWeight:700,marginBottom:2}}>{item.t}</div><div style={{fontSize:11,color:T.mu}}>{item.d}</div></div><span style={{fontSize:10,color:T.mu,whiteSpace:"nowrap"}}>Not connected</span></div>))}
    </div>
    {showModal&&<Modal title="Add Business" onClose={()=>setShowModal(false)}><Inp label="Business Name" value={form.business_name} onChange={v=>setForm(p=>({...p,business_name:v}))} placeholder="Iron Forge Gym"/><Inp label="Email" value={form.email} onChange={v=>setForm(p=>({...p,email:v}))} placeholder="owner@ironforge.com"/><Sel label="Plan" value={form.plan} onChange={v=>setForm(p=>({...p,plan:v}))} options={[{value:"Local",label:"Local - $29/mo"},{value:"Growth",label:"Growth - $99/mo"},{value:"Scale",label:"Scale - $299/mo"}]}/><div style={{display:"flex",gap:10,marginTop:8}}><Btn onClick={save} disabled={saving} full>{saving?"Saving...":"Save"}</Btn><Btn variant="secondary" onClick={()=>setShowModal(false)}>Cancel</Btn></div></Modal>}
  </div>);
}

function CampaignModal({tok,onClose,onSave}){
  const[form,setForm]=useState({name:"",trigger:"",gift_name:"",gift_cost:"",platform:"Square",status:"active"});const[saving,setSaving]=useState(false);
  const save=async()=>{if(!form.name||!form.trigger||!form.gift_name)return;setSaving(true);try{await db.insert("campaigns",{name:form.name,trigger:form.trigger,gift_name:form.gift_name,gift_cost:parseFloat(form.gift_cost)||0,platform:form.platform,status:form.status},tok);onSave();}catch(e){alert(e.message);}setSaving(false);};
  return(<Modal title="🎁 New Campaign" onClose={onClose}><Inp label="Campaign Name" value={form.name} onChange={v=>setForm(p=>({...p,name:v}))} placeholder="Welcome Kit"/><Sel label="Platform" value={form.platform} onChange={v=>setForm(p=>({...p,platform:v}))} options={[{value:"Square",label:"Square"},{value:"Shopify",label:"Shopify"},{value:"Stripe",label:"Stripe"},{value:"Toast",label:"Toast"},{value:"Clover",label:"Clover"},{value:"Mindbody",label:"Mindbody"}]}/><Sel label="Trigger" value={form.trigger} onChange={v=>setForm(p=>({...p,trigger:v}))} options={[{value:"New Signup",label:"New Signup"},{value:"First Purchase",label:"First Purchase"},{value:"5th Visit",label:"5th Visit"},{value:"30-day Inactive",label:"30-day Inactive"},{value:"Birthday",label:"Birthday"},{value:"Churn Risk",label:"Churn Risk"}]}/><Inp label="Gift Name" value={form.gift_name} onChange={v=>setForm(p=>({...p,gift_name:v}))} placeholder="Branded Water Bottle"/><Inp label="Gift Cost ($)" type="number" value={form.gift_cost} onChange={v=>setForm(p=>({...p,gift_cost:v}))} placeholder="7"/><div style={{display:"flex",gap:10,marginTop:8}}><Btn onClick={save} disabled={saving} full>{saving?"Creating...":"Create Campaign"}</Btn><Btn variant="secondary" onClick={onClose}>Cancel</Btn></div></Modal>);
}

export default function App(){
  const[screen,setScreen]=useState("land");
  const[session,setSession]=useState(()=>{
    try{const t=localStorage.getItem("ct_token");const u=localStorage.getItem("ct_user");if(t&&u)return{token:t,user:JSON.parse(u)};}catch{}return null;
  });

  const handleAuth=(token,user)=>{setSession({token,user});setScreen("dash");};
  const handleLogout=async()=>{
    try{if(session?.token)await auth.signOut(session.token);}catch{}
    localStorage.removeItem("ct_token");localStorage.removeItem("ct_user");setSession(null);setScreen("land");
  };
  const go=(s)=>setScreen(s);

  return(<>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,700&family=DM+Sans:wght@300;400;500;600&display=swap');
      *{box-sizing:border-box;margin:0;padding:0}body{background:#080A0F;overflow-x:hidden}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
      @keyframes fadeSlide{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      @keyframes spin{to{transform:rotate(360deg)}}
      input[type=range]{-webkit-appearance:none;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);outline:none;cursor:pointer}
      input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;cursor:pointer;background:#FF5C00}
      ::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:3px}
      select option{background:#141820}a{color:inherit;text-decoration:none}
    `}</style>
    {screen==="land"   &&<Landing go={go} session={session}/>}
    {screen==="roi"    &&<ROI go={go}/>}
    {screen==="login"  &&<AuthPage go={go} mode="login" onAuth={handleAuth}/>}
    {screen==="signup" &&<AuthPage go={go} mode="signup" onAuth={handleAuth}/>}
    {screen==="dash"   &&(session?<Dashboard go={go} session={session} onLogout={handleLogout}/>:<AuthPage go={go} mode="login" onAuth={handleAuth}/>)}
  </>);
}

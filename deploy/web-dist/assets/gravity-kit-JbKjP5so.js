import{V as e}from"./design-library-PLdIta_8.js";import{t}from"./cue-ring-BxAH_HFs.js";var n=e(),r=[{glyph:`✉`,label:`Mail`},{glyph:`▤`,label:`Calendar`},{glyph:`◍`,label:`Messages`},{glyph:`✓`,label:`Tasks`}],i=`
[data-gv]{
  --gv-bg:#0B0B0F; --gv-bg-deep:#030306; --gv-surface:#16161D;
  --gv-border:#2A2A35; --gv-text:#F4F4F6; --gv-muted:#9A9AA8;
  --gv-accent:#3D6EE8; --gv-accent-text:#8FA9F2; --gv-on-accent:#FFFFFF;
  --gv-error:#E5675B; --gv-ok:#5FD08A;
  /* M8's consent cards. --gv-body is card copy: a real muted-on-dark stop, NOT
     an opacity wrapper over --gv-text. Design's rule is that explanatory copy
     stays at full strength and receding happens by token, never by dimming the
     container. --gv-hold-text is the amber TEXT leg (the fill leg #B4770F fails
     as small copy on light); --gv-ok-fill is a ground under a white knob, so it
     takes the text stop of its hue on both themes. */
  --gv-body:#C9C9D4; --gv-hold-text:#E0A64B;
  --gv-ok-fill:#277E41; --gv-track:rgba(255,255,255,.14);
  --gv-glass:rgba(255,255,255,.045); --gv-glass-line:rgba(255,255,255,.10);
  --gv-aurora:rgba(61,110,232,.30);
  /* M7's bottom sheet. Opaque, not glass: the orbit passes BEHIND its top edge
     as it scales, and a translucent sheet would show the mark through the
     fields it is supposed to have made room for. */
  --gv-sheet:rgba(20,23,32,.98); --gv-grabber:rgba(255,255,255,.22);
  --gv-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --gv-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
}
[data-theme="light"] [data-gv], [data-gv][data-gv-theme="light"]{
  --gv-bg:#F6F6F8; --gv-bg-deep:#EDEDF1; --gv-surface:#FFFFFF;
  --gv-border:#E2E2E8; --gv-text:#17171C; --gv-muted:#6A6A76;
  --gv-accent:#3D6EE8; --gv-accent-text:#2B53C4; --gv-on-accent:#FFFFFF;
  --gv-error:#C4372B; --gv-ok:#277E41;
  --gv-body:#3A3A44; --gv-hold-text:#8A5A08;
  --gv-ok-fill:#277E41; --gv-track:rgba(23,23,28,.12);
  --gv-glass:rgba(23,23,28,.035); --gv-glass-line:rgba(23,23,28,.10);
  --gv-aurora:rgba(61,110,232,.18);
  --gv-sheet:#FFFFFF; --gv-grabber:rgba(23,23,28,.18);
}
@keyframes gvSpin{to{transform:rotate(360deg)}}
@keyframes gvSpinR{to{transform:rotate(-360deg)}}
@keyframes gvFall{0%{transform:translateX(330px) scale(.6);opacity:0}12%{opacity:1}55%,100%{transform:translateX(108px) scale(1);opacity:1}}
@keyframes gvFall2{0%{transform:translateX(360px) scale(.6);opacity:0}14%{opacity:.9}60%,100%{transform:translateX(150px) scale(1);opacity:.9}}
@keyframes gvDraw{0%,18%{stroke-dashoffset:707}62%,100%{stroke-dashoffset:0}}
@keyframes gvDot{0%,58%{opacity:0;transform:scale(0)}68%{opacity:1;transform:scale(1.6)}76%,100%{opacity:1;transform:scale(1)}}
@keyframes gvW1{0%,9%{opacity:0;transform:translateY(30px)}15%,22%{opacity:1;transform:translateY(0)}28%,100%{opacity:0;transform:translateY(-26px)}}
@keyframes gvW2{0%,31%{opacity:0;transform:translateY(30px)}37%,44%{opacity:1;transform:translateY(0)}50%,100%{opacity:0;transform:translateY(-26px)}}
@keyframes gvW3{0%,53%{opacity:0;transform:translateY(30px)}59%,66%{opacity:1;transform:translateY(0)}72%,100%{opacity:0;transform:translateY(-26px)}}
@keyframes gvW4{0%,75%{opacity:0;transform:translateY(30px)}83%,96%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-10px)}}
@keyframes gvFil{0%,55%{opacity:0}68%,86%{opacity:.6}100%{opacity:0}}
@keyframes gvRise{0%{opacity:0;transform:translateY(26px)}100%{opacity:1;transform:translateY(0)}}
@keyframes gvGlow{0%,100%{opacity:.45;transform:scale(1)}50%{opacity:1;transform:scale(1.22)}}
@keyframes gvAur{0%,100%{transform:translate(-10%,-5%) scale(1) rotate(0deg)}50%{transform:translate(8%,7%) scale(1.3) rotate(8deg)}}
@keyframes gvStreak{0%{transform:translateX(300px) scaleX(.3);opacity:0}10%{opacity:1}70%{transform:translateX(30px) scaleX(1.4);opacity:.9}100%{transform:translateX(-10px) scaleX(.2);opacity:0}}
@keyframes gvSweep{0%{stroke-dashoffset:200}70%,100%{stroke-dashoffset:0}}
@keyframes gvBloom{0%,70%{transform:scale(.9);opacity:0}78%{opacity:.65}100%{transform:scale(11);opacity:0}}
@keyframes gvSheen{0%{transform:translateX(-160%) skewX(-18deg)}55%,100%{transform:translateX(220%) skewX(-18deg)}}
@keyframes gvBreathScale{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}
@keyframes gvTwinkle{0%,100%{opacity:.1}50%{opacity:.8}}

/* Reduced motion: freeze to the composed mid-state. Every animated element's
   BASE style is already its settled state, so removing the animation lands on
   the pack's static frame instead of an unplayed keyframe's 0%. */
@media (prefers-reduced-motion: reduce){
  [data-gv] *, [data-gv]{ animation: none !important; transition: none !important; }
}
`;function a(){return(0,n.jsx)(`style`,{"data-gv-styles":!0,children:i})}function o(){try{return globalThis.window?.matchMedia?.(`(prefers-reduced-motion: reduce)`).matches===!0}catch{return!1}}function s(e,t){return e===`empty`||e===`frozen`?`none`:`${t?`gvSpinR`:`gvSpin`} ${e===`converging`?9:e===`falling`?22:30}s linear infinite`}function c({mode:e,size:i=300,dim:a=!1}){let o=e===`empty`||e===`frozen`,c=e===`falling`,p=e!==`empty`;return(0,n.jsxs)(`div`,{"aria-hidden":!0,"data-gv-system":e,style:{position:`relative`,width:i,height:i,opacity:a?.42:1,filter:e===`frozen`?`grayscale(1)`:void 0,transition:`opacity .4s ease`,pointerEvents:`none`,flexShrink:0},children:[(0,n.jsx)(`div`,{style:{position:`absolute`,inset:`-30%`,background:`radial-gradient(46% 40% at 50% 50%, var(--gv-aurora), transparent 70%)`,filter:`blur(34px)`,animation:o?`none`:`gvAur 13s ease-in-out infinite`,willChange:`transform`}}),(0,n.jsx)(l,{radius:i*.5,animation:s(e,!1),dashed:e===`decayed`,children:p?r.slice(0,2).map((t,r)=>(0,n.jsx)(u,{chip:t,offset:i*.36,falling:c,fallKeyframe:`gvFall`,delay:r*.55,counterSpin:s(e,!0)},t.label)):null}),(0,n.jsx)(l,{radius:i*.34,animation:s(e,!0),dashed:e===`decayed`,children:p?r.slice(2).map((t,r)=>(0,n.jsx)(u,{chip:t,offset:i*.24,falling:c,fallKeyframe:`gvFall2`,delay:.3+r*.55,counterSpin:s(e,!1)},t.label)):null}),e===`converging`?(0,n.jsx)(`div`,{style:{position:`absolute`,inset:0,overflow:`hidden`},children:[0,1,2,3,4,5].map(e=>(0,n.jsx)(`span`,{style:{position:`absolute`,top:`${14+e*13}%`,left:`50%`,width:90,height:2,borderRadius:2,background:`linear-gradient(90deg, transparent, var(--gv-accent))`,transformOrigin:`right center`,animation:`gvStreak ${1.1+e%3*.22}s ease-in infinite`,animationDelay:`${e*.13}s`,willChange:`transform, opacity`}},e))}):null,(0,n.jsxs)(`div`,{style:{position:`absolute`,inset:0,display:`flex`,alignItems:`center`,justifyContent:`center`},children:[(0,n.jsx)(`div`,{style:{position:`absolute`,width:i*.44,height:i*.44,borderRadius:`50%`,background:`radial-gradient(circle, var(--gv-aurora), transparent 70%)`,animation:o?`none`:`gvGlow 4.5s ease-in-out infinite`}}),c?(0,n.jsx)(d,{size:i*.34}):(0,n.jsx)(t,{size:i*.34,stroke:`var(--gv-text)`,style:o?void 0:{animation:`gvBreathScale 6s ease-in-out infinite`}}),e===`converging`?(0,n.jsx)(f,{size:i*.52}):null]}),e===`converging`?(0,n.jsx)(`div`,{style:{position:`absolute`,inset:`35%`,borderRadius:`50%`,border:`2px solid var(--gv-accent)`,animation:`gvBloom 2.4s ease-in infinite`,willChange:`transform, opacity`}}):null]})}function l({radius:e,animation:t,dashed:r,children:i}){return(0,n.jsxs)(`div`,{style:{position:`absolute`,inset:0,display:`flex`,alignItems:`center`,justifyContent:`center`},children:[(0,n.jsx)(`div`,{style:{position:`absolute`,width:e*2,height:e*2,borderRadius:`50%`,border:`1px ${r?`dashed`:`solid`} var(--gv-border)`,opacity:r?.55:.8}}),(0,n.jsx)(`div`,{style:{position:`absolute`,width:e*2,height:e*2,animation:t,willChange:`transform`},children:i})]})}function u({chip:e,offset:t,falling:r,fallKeyframe:i,delay:a,counterSpin:o}){return(0,n.jsx)(`span`,{style:{position:`absolute`,top:`50%`,left:`50%`,marginTop:-16,marginLeft:-16,width:32,height:32,transform:`translateX(${t}px)`,animation:r?`${i} 9s cubic-bezier(.2,.7,.2,1) ${a}s both`:void 0,willChange:`transform, opacity`},children:(0,n.jsx)(`span`,{style:{display:`flex`,width:32,height:32,alignItems:`center`,justifyContent:`center`,borderRadius:10,background:`var(--gv-surface)`,border:`1px solid var(--gv-border)`,color:`var(--gv-text)`,fontSize:15,lineHeight:1,animation:o===`none`?void 0:o},children:e.glyph})})}function d({size:e}){return(0,n.jsxs)(`svg`,{width:e,height:e,viewBox:`0 0 512 512`,"aria-hidden":!0,children:[(0,n.jsx)(`circle`,{cx:`232`,cy:`256`,r:`150`,fill:`none`,stroke:`var(--gv-text)`,strokeWidth:`42`,strokeLinecap:`round`,strokeDasharray:`707 236`,transform:`rotate(42 232 256)`,style:{strokeDashoffset:0,animation:`gvDraw 9s cubic-bezier(.4,0,.2,1) both`}}),(0,n.jsx)(`circle`,{cx:`392`,cy:`372`,r:`32`,fill:`#3D6EE8`,style:{transformOrigin:`392px 372px`,animation:`gvDot 9s cubic-bezier(.3,1.4,.4,1) both`}})]})}function f({size:e}){return(0,n.jsx)(`svg`,{width:e,height:e,viewBox:`0 0 100 100`,"aria-hidden":!0,style:{position:`absolute`,transform:`rotate(-90deg)`},children:(0,n.jsx)(`circle`,{cx:`50`,cy:`50`,r:`46`,fill:`none`,stroke:`var(--gv-accent)`,strokeWidth:`2`,strokeLinecap:`round`,strokeDasharray:`290`,style:{strokeDashoffset:0,animation:`gvSweep 2.4s ease-out both`}})})}export{c as n,o as r,a as t};
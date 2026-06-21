import{o as e}from"./chunk-jRWAZmH_.js";import{t}from"./react-DJZBPgpf.js";import{h as n}from"./chunk-5KNZJZUH-DdS6bb-3.js";import{t as r}from"./jsx-runtime-CVSDxk6A.js";import{B as i,F as a,I as o}from"./index-DY9SRfnT.js";var s=e(t(),1),c=r();function l(){return(0,c.jsxs)(`svg`,{className:`oauth-icon`,viewBox:`0 0 56 56`,fill:`none`,xmlns:`http://www.w3.org/2000/svg`,children:[(0,c.jsx)(`circle`,{cx:`28`,cy:`28`,r:`28`,fill:`var(--oauth-positive-bg)`}),(0,c.jsx)(`path`,{className:`oauth-check`,d:`M17 28.5L24.5 36L39 21`,stroke:`var(--oauth-positive-fg)`,strokeWidth:`3.5`,strokeLinecap:`round`,strokeLinejoin:`round`,fill:`none`})]})}function u(){return(0,c.jsxs)(`svg`,{className:`oauth-icon`,viewBox:`0 0 56 56`,fill:`none`,xmlns:`http://www.w3.org/2000/svg`,children:[(0,c.jsx)(`circle`,{cx:`28`,cy:`28`,r:`28`,fill:`var(--oauth-negative-bg)`}),(0,c.jsx)(`path`,{className:`oauth-cross oauth-cross-1`,d:`M20 20L36 36`,stroke:`var(--oauth-negative-fg)`,strokeWidth:`3.5`,strokeLinecap:`round`,fill:`none`}),(0,c.jsx)(`path`,{className:`oauth-cross oauth-cross-2`,d:`M36 20L20 36`,stroke:`var(--oauth-negative-fg)`,strokeWidth:`3.5`,strokeLinecap:`round`,fill:`none`})]})}var d=`
  :root {
    --oauth-surface: #F5F3EB;
    --oauth-surface-card: #FFFFFF;
    --oauth-card-border: #E8E6DA;
    --oauth-text-primary: #2A2A28;
    --oauth-text-secondary: #4A4A46;
    --oauth-positive-bg: #D4DFD0;
    --oauth-positive-fg: #516748;
    --oauth-negative-bg: #F7DAC9;
    --oauth-negative-fg: #DA491A;
    --oauth-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06);
    --oauth-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not(.light) {
      --oauth-surface: #1A1A18;
      --oauth-surface-card: #2A2A28;
      --oauth-card-border: #3A3A37;
      --oauth-text-primary: #F5F3EB;
      --oauth-text-secondary: #BDB9A9;
      --oauth-positive-bg: #1A2316;
      --oauth-positive-fg: #7A8B6F;
      --oauth-negative-bg: #4E281D;
      --oauth-negative-fg: #E86B40;
      --oauth-shadow: 0 1px 3px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.3);
    }
  }
  :root[data-theme="dark"] {
    --oauth-surface: #1A1A18;
    --oauth-surface-card: #2A2A28;
    --oauth-card-border: #3A3A37;
    --oauth-text-primary: #F5F3EB;
    --oauth-text-secondary: #BDB9A9;
    --oauth-positive-bg: #1A2316;
    --oauth-positive-fg: #7A8B6F;
    --oauth-negative-bg: #4E281D;
    --oauth-negative-fg: #E86B40;
    --oauth-shadow: 0 1px 3px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.3);
  }
  .oauth-page {
    font-family: var(--oauth-font);
    background: var(--oauth-surface);
    color: var(--oauth-text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    padding: 0;
    -webkit-font-smoothing: antialiased;
  }
  .oauth-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 48px 40px 40px;
    background: var(--oauth-surface-card);
    border: 1px solid var(--oauth-card-border);
    border-radius: 16px;
    box-shadow: var(--oauth-shadow);
    max-width: 380px;
    width: 100%;
    opacity: 0;
    transform: translateY(8px) scale(0.98);
    animation: oauthCardIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.1s forwards;
  }
  @keyframes oauthCardIn {
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .oauth-icon {
    width: 56px;
    height: 56px;
    margin-bottom: 20px;
    flex-shrink: 0;
  }
  .oauth-check {
    stroke-dasharray: 32;
    stroke-dashoffset: 32;
    animation: oauthDraw 0.4s ease-out 0.45s forwards;
  }
  .oauth-cross {
    stroke-dasharray: 22;
    stroke-dashoffset: 22;
  }
  .oauth-cross-1 { animation: oauthDraw 0.3s ease-out 0.45s forwards; }
  .oauth-cross-2 { animation: oauthDraw 0.3s ease-out 0.55s forwards; }
  @keyframes oauthDraw {
    to { stroke-dashoffset: 0; }
  }
  .oauth-card h1 {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.2px;
    color: var(--oauth-text-primary);
    margin: 0 0 6px;
  }
  .oauth-card p {
    font-size: 13px;
    line-height: 1.5;
    color: var(--oauth-text-secondary);
    margin: 0;
  }
`;function f(e){return e.split(/[-_]/).map(e=>e.charAt(0).toUpperCase()+e.slice(1)).join(` `)}function p(){let[e]=n(),t=e.get(`requestId`),r=e.get(`oauth_status`),p=e.get(`oauth_provider`),m=e.get(`oauth_code`),h=e.get(`native`)===`1`,g=p?f(p):``,_=r===`connected`,v=_?g?`Connected to ${g}`:`Authorization Successful`:`Authorization Failed`,y=_?`You can close this popup and return to the app.`:`${g||`Service`} connection failed. Please try again.`;return(0,s.useEffect)(()=>{if(h&&t){let e=o(window.location.host);if(e){window.location.href=a(e,{requestId:t,oauthStatus:r||null,oauthProvider:p||null,oauthCode:m||null});return}}let e={type:`vellum:oauth-complete`,requestId:t,oauthStatus:r||null,oauthProvider:p||null,oauthCode:m||null};if(window.opener&&t&&window.opener.postMessage(e,window.location.origin),t)try{window.localStorage.setItem(i(t),JSON.stringify(e))}catch{}window.close()},[t,r,p,m,h]),(0,c.jsxs)(`div`,{className:`oauth-page`,children:[(0,c.jsx)(`style`,{dangerouslySetInnerHTML:{__html:d}}),(0,c.jsxs)(`div`,{className:`oauth-card`,children:[_?(0,c.jsx)(l,{}):(0,c.jsx)(u,{}),(0,c.jsx)(`h1`,{children:v}),(0,c.jsx)(`p`,{children:y}),!_&&m&&(0,c.jsxs)(`p`,{style:{marginTop:8,fontSize:11,color:`var(--oauth-text-secondary)`,opacity:.7},children:[`Error: `,m]})]})]})}export{p as OAuthPopupCompletePage};
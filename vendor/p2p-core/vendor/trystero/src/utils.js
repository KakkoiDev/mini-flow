/* esm.sh - trystero@0.21.5/src/utils */
// Local patch for Trystero 0.21.5: keep readiness across retries and
// replay active Nostr subscriptions when a socket reconnects.
function makeRelaySocket(url, onMessage, restoreSubscriptions = false) {
  let resolveReady;
  let delay = 3333;
  const subscriptions = new Map();
  const relay = { ready: new Promise(resolve => { resolveReady = resolve; }) };

  function connect() {
    const socket = new WebSocket(url);
    relay.socket = socket;
    relay.url = socket.url;
    socket.onmessage = event => onMessage(event.data);
    socket.onclose = () => {
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 60000);
    };
    socket.onopen = () => {
      delay = 3333;
      for (const request of subscriptions.values()) socket.send(request);
      resolveReady(relay);
    };
  }

  relay.send = message => {
    if (restoreSubscriptions) {
      const [kind, id] = JSON.parse(message);
      if (kind === 'REQ') subscriptions.set(id, message);
      if (kind === 'CLOSE') subscriptions.delete(id);
    }
    if (relay.socket.readyState === 1) relay.socket.send(message);
  };
  connect();
  return relay;
}
var{floor:a,random:p,sin:i}=Math,x="Trystero",y=(e,o)=>Array(e).fill().map(o),d="0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz",m=e=>y(e,()=>d[a(p()*d.length)]).join(""),E=m(20),N=Promise.all.bind(Promise),T=typeof window<"u",{entries:k,fromEntries:u,keys:b}=Object,P=()=>{},R=e=>new Error(`${x}: ${e}`),h=new TextEncoder,w=new TextDecoder,U=e=>h.encode(e),g=e=>w.decode(e),j=e=>e.reduce((o,t)=>o+t.toString(16).padStart(2,"0"),""),A=(...e)=>e.join("@"),S=(e,o)=>{let t=[...e],s=()=>{let n=i(o++)*1e4;return n-a(n)},r=t.length;for(;r;){let n=a(s()*r--);[t[r],t[n]]=[t[n],t[r]]}return t},I=(e,o,t,s)=>(e.relayUrls||(s?S(o,f(e.appId)):o)).slice(0,e.relayUrls?e.relayUrls.length:e.relayRedundancy||t),J=JSON.stringify,O=JSON.parse,f=(e,o=Number.MAX_SAFE_INTEGER)=>e.split("").reduce((t,s)=>t+s.charCodeAt(0),0)%o,B=makeRelaySocket,M=e=>()=>u(k(e).map(([o,t])=>[o,t.socket]));export{N as all,y as alloc,g as decodeBytes,U as encodeBytes,k as entries,u as fromEntries,O as fromJson,m as genId,I as getRelays,T as isBrowser,b as keys,x as libName,B as makeSocket,R as mkErr,P as noOp,E as selfId,M as socketGetter,f as strToNum,j as toHex,J as toJson,A as topicPath};
//# sourceMappingURL=utils.mjs.map

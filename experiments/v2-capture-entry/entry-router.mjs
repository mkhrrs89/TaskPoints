// Experimental server-side selection. Never imported by the deployed worker.
const ROOT='/experiments/v2-capture-entry/';
export const SELECTOR='tp_capture';
export const VALUE='synthetic-v1';
export async function routeCapture(request,env,ctx,normalFetch){
  const url=new URL(request.url);
  if(!url.searchParams.has(SELECTOR))return normalFetch(request,env,ctx);
  // A selected but invalid mode NEVER falls back to ordinary app startup.
  const headers={'cache-control':'no-store','content-type':'text/plain; charset=utf-8','x-content-type-options':'nosniff'};
  if(!['localhost','127.0.0.1'].includes(url.hostname)||env.CAPTURE_EXPERIMENT!=='synthetic-only')
    return new Response('Capture experiment is disabled outside the synthetic local fixture.',{status:403,headers});
  if(!['/','/index.html'].includes(url.pathname)||url.search!==`?${SELECTOR}=${VALUE}`||request.method!=='GET')
    return new Response('Invalid capture entry. Ordinary startup was not run.',{status:400,headers});
  try{
    // Fetch the capture document directly from assets, before the V1 worker or
    // its Home HTML rewriting/preloads can run. No redirect, index fetch or JS gate.
    const response=await env.ASSETS.fetch(new Request(new URL(ROOT+'capture.html',url.origin)));
    if(!response.ok)throw Error('capture asset unavailable');
    return new Response(response.body,{status:200,headers:{
      ...headers,'content-type':'text/html; charset=utf-8','x-taskpoints-capture-entry':'synthetic-v1',
      'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy':'no-referrer'
    }});
  }catch(_){return new Response('Capture entry unavailable. Ordinary startup was not run.',{status:503,headers});}
}

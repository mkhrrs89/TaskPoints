// NOT the production worker entry point. Local synthetic rehearsal only.
import normalWorker from '../../_worker.js';
import {routeCapture} from './entry-router.mjs';
export default {
  fetch(request,env,ctx){
    return routeCapture(request,env,ctx,(r,e,c)=>normalWorker.fetch(r,e,c));
  }
};

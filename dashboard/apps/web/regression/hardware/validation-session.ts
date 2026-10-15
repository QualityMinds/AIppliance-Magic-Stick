import {withCleanup} from '../core/run-lifecycle.ts';

/** Verification Jobs can run for tens of minutes. Keep the real UI request and
 * terminal result assertions, but do not render/poll the dashboard throughout
 * the independently observed GPU work or reuse that renderer for another engine.
 * There is no browser retry and no synthetic validation result. */
export async function validationSession<Page extends {close():Promise<void>},Request>(
  open:()=>Promise<Page>,request:(page:Page)=>Promise<Request>,
  completed:(request:Request)=>Promise<unknown>,inspect:(page:Page,request:Request)=>Promise<void>,
):Promise<Request> {
  const submitting=await open();
  const accepted=await withCleanup(()=>request(submitting),()=>submitting.close());
  await completed(accepted);
  const terminal=await open();
  await withCleanup(()=>inspect(terminal,accepted),()=>terminal.close());
  return accepted;
}

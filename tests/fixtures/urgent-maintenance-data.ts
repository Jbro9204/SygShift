// Isolated transport for real components/parsers; no live account or provider.
import { getSupabaseClient as clockClient } from './clock-data'
export * from './clock-data'
const employeeId='10000000-0000-4000-8000-000000000001'
const shiftId='20000000-0000-4000-8000-000000000001'
const serverTimestamp='2026-09-06T16:00:00Z'
export const fullMaintenance={
  id:'90000000-0000-4000-8000-000000000001',title:'Full database maintenance',
  message:'Manager and time-attendance changes remain read only. Employee urgent access stays available.',
  status:'active',accessMode:'read_only',featureCodes:['availability','communications','directory','events_openings','licensing','patrol','payroll','roles_permissions','schedule','sites_posts','time_attendance','training','user_accounts'],
  startsAt:'2026-09-06T15:00:00Z',endsAt:'2026-09-07T11:00:00Z',releaseKind:'database',releaseVersion:null,
}
export function getSupabaseClient(){
  const base=clockClient()
  const resolveRpc=async(name:string,input?:Record<string,unknown>)=>{
    if(name==='get_payroll_period_context')return{error:null,data:{serverTimestamp,fromDate:'2026-09-06',throughDate:'2026-09-19',timeZone:'America/Denver',weekStartsOn:0,weekStartsOnLabel:'Sunday',payFrequency:'biweekly',payrollConfigurationVersion:2,availablePeriods:[{offset:0,fromDate:'2026-09-06',throughDate:'2026-09-19'}]}}
    if(name==='get_request_center_payload')return{error:null,data:{employeeId,employeeTimeZone:'America/New_York',role:'guard',permissions:{canManage:false},timeOff:[],shiftRequests:[],callOffs:[],upcomingAssignments:[{id:shiftId,status:'assigned',shift:{id:shiftId,startsAt:'2026-09-07T20:00:00Z',endsAt:'2026-09-08T00:00:00Z',timeZone:'America/Denver',title:'Front desk',location:'Test site'}}]}}
    if(name==='get_maintenance_status')return{error:null,data:{serverTime:serverTimestamp,active:[fullMaintenance],upcoming:[],recentlyCompleted:[]}}
    if(name==='get_time_work_type_map'||name==='get_time_payroll_category_map')return{error:null,data:[]}
    if(/^(update_|apply_|resolve_|service_)/u.test(name))return{data:null,error:{code:'42501',message:'Full database maintenance is temporarily read-only for manager/time-attendance changes.'}}
    return base.rpc(name,input)
  }
  return{...base,auth:{getSession:async()=>({data:{session:{access_token:'isolated-fixture-token'}},error:null})},rpc(name:string,input?:Record<string,unknown>){
    const request=resolveRpc(name,input) as Promise<unknown>&{abortSignal:()=>Promise<unknown>}
    request.abortSignal=()=>request
    return request
  }}
}

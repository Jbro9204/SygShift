import {createRoot} from 'react-dom/client'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {MemoryRouter} from 'react-router-dom'
import {MyTimePage} from '../../src/time/MyTimePage'
import {RequestsPage} from '../../src/pages/RequestsPage'
import {MaintenanceNotice} from '../../src/components/MaintenanceNotice'
import {fullMaintenance} from './urgent-maintenance-data'
import '../../src/index.css'
import '../../src/App.css'
const params=new URLSearchParams(location.search)
document.documentElement.dataset.theme='light'
const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
client.setQueryData(['maintenance-status'],{active:[fullMaintenance],upcoming:[],recentlyCompleted:[]})
const requests=params.get('surface')==='requests'
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[requests?'/time-off?tab=call-offs':'/time/my-time']}><main style={{padding:16}}><MaintenanceNotice active={fullMaintenance as never} completed={null} upcoming={null}/>{requests?<RequestsPage/>:<MyTimePage/>}</main></MemoryRouter></QueryClientProvider>)

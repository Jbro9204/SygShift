import {createRoot} from 'react-dom/client'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {MemoryRouter} from 'react-router-dom'
import {UrgentCallOffPage} from '../../src/time/AttendanceReport'
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
const surface = params.get('surface')
const path = surface === 'requests' ? '/time-off?tab=call-offs'
  : surface === 'urgent-call-off' ? '/time/my-time?report=call-off' : '/time/my-time'
const workspace = surface === 'requests' ? <RequestsPage />
  : surface === 'urgent-call-off' ? <UrgentCallOffPage /> : <MyTimePage />

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[path]}>
      <main style={{ padding: 16 }}>
        <MaintenanceNotice active={fullMaintenance as never} completed={null} upcoming={null} />
        {workspace}
      </main>
    </MemoryRouter>
  </QueryClientProvider>,
)

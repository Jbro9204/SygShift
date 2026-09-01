import { RouterProvider } from 'react-router-dom'
import { router } from './app/router'
import { IdentityVerificationHost } from './components/IdentityVerificationHost'
import { ReleaseUpdateNotice } from './components/ReleaseUpdateNotice'
import './App.css'
import './theme.css'

function App() {
  return (
    <>
      <ReleaseUpdateNotice />
      <RouterProvider router={router} />
      <IdentityVerificationHost />
    </>
  )
}

export default App

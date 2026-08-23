import { RouterProvider } from 'react-router-dom'
import { router } from './app/router'
import { ReleaseUpdateNotice } from './components/ReleaseUpdateNotice'
import './App.css'

function App() {
  return (
    <>
      <ReleaseUpdateNotice />
      <RouterProvider router={router} />
    </>
  )
}

export default App

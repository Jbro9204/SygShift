import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Phone, PhoneOff } from 'lucide-react'
import {
  bootstrapSygSphereCommunications,
  directCallEndCommand,
  directCallInvitationCommand,
  directMediaAnswerCommand,
  getSygSphereDirectCallContext,
  openSygSphereCommunicationsSocket,
  prepareSygSphereDirectAudio,
  refreshSygSphereCommunicationsAuthorization,
  sendSygSphereCommunicationsCommand,
  startSygSphereDirectAudio,
} from '../data/sygsphereCommunications'
import type { ValidatedSygSphereCommsEvent } from '../../shared/sygsphere-communications/v1/contract'

export const SYGSPHERE_COMMS_RUNTIME_EVENT = 'sygsphere:communications-runtime'
export const SYGSPHERE_COMMS_EVENT = 'sygsphere:communications-event'

type IncomingCall = Readonly<{ callId: string, invitationId: string }>
type ActiveCall = Readonly<{ callId: string, conversationReference: string, state: 'connected' | 'joining' | 'live' }>
type MediaNegotiation = Readonly<{
  callId: string
  description: string
  descriptionType: 'answer' | 'offer'
  generation: number
  iceServers: RTCIceServer[]
  negotiationId: string
  peerHandle: string
}>

function publishRuntime(state: 'ready' | 'unavailable'): void {
  document.documentElement.dataset.sygsphereCommunications = state
  window.dispatchEvent(new CustomEvent(SYGSPHERE_COMMS_RUNTIME_EVENT, { detail: { state } }))
}

function publishEvent(event: ValidatedSygSphereCommsEvent): void {
  window.dispatchEvent(new CustomEvent(SYGSPHERE_COMMS_EVENT, { detail: event }))
}

/** Persistent, app-shell communications delivery host. It keeps the socket
 * alive across route changes so an incoming direct call can reach an employee
 * while they are working anywhere in SygShift. */
export function SygSphereCommunicationsRuntime({ enabled }: { enabled: boolean }) {
  const [incoming, setIncoming] = useState<IncomingCall | null>(null)
  const [active, setActive] = useState<ActiveCall | null>(null)
  const [notice, setNotice] = useState('')
  const [muted, setMuted] = useState(false)
  const activeRef = useRef<ActiveCall | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const retryRef = useRef<number | null>(null)
  const refreshRef = useRef<number | null>(null)
  const retryDelayRef = useRef(1_000)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const callAlertRef = useRef<HTMLAudioElement | null>(null)
  const [callAlertBlocked, setCallAlertBlocked] = useState(false)

  const updateActive = (next: ActiveCall | null) => {
    activeRef.current = next
    setActive(next)
  }

  const closeAudio = () => {
    peerRef.current?.close()
    peerRef.current = null
    for (const track of localStreamRef.current?.getTracks() ?? []) track.stop()
    localStreamRef.current = null
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null
    setMuted(false)
  }

  const resolveActiveCall = async (callId: string) => {
    try {
      const context = await getSygSphereDirectCallContext(callId)
      updateActive({ callId, conversationReference: context.conversationReference, state: 'connected' })
      setNotice('Call connected. Join audio when you are ready.')
    } catch {
      setNotice('The call is no longer available.')
    }
  }

  useEffect(() => {
    if (!incoming) {
      callAlertRef.current?.pause()
      if (callAlertRef.current) callAlertRef.current.currentTime = 0
      callAlertRef.current = null
      setCallAlertBlocked(false)
      return undefined
    }
    const alert = new Audio('/sounds/SygSphere_Notification_46421aca.mp3')
    alert.loop = true
    alert.volume = 0.65
    callAlertRef.current = alert
    void alert.play().then(() => setCallAlertBlocked(false)).catch(() => setCallAlertBlocked(true))
    return () => {
      alert.pause()
      alert.currentTime = 0
      if (callAlertRef.current === alert) callAlertRef.current = null
    }
  }, [incoming])

  const enableCallAlert = async () => {
    const alert = callAlertRef.current
    if (!alert) return
    try {
      await alert.play()
      setCallAlertBlocked(false)
    } catch {
      setCallAlertBlocked(true)
    }
  }

  useEffect(() => {
    if (!enabled) {
      publishRuntime('unavailable')
      return undefined
    }
    let disposed = false
    const clearTimers = () => {
      if (retryRef.current !== null) window.clearTimeout(retryRef.current)
      if (refreshRef.current !== null) window.clearInterval(refreshRef.current)
      retryRef.current = null
      refreshRef.current = null
    }
    const retry = () => {
      if (disposed || retryRef.current !== null) return
      publishRuntime('unavailable')
      const delay = retryDelayRef.current
      retryDelayRef.current = Math.min(30_000, retryDelayRef.current * 2)
      retryRef.current = window.setTimeout(() => {
        retryRef.current = null
        void connect()
      }, delay)
    }
    const onEvent = (event: ValidatedSygSphereCommsEvent) => {
      if (event.kind === 'call.ringing') {
        const payload = event.payload as { callId: string, invitationId: string }
        setIncoming({ callId: payload.callId, invitationId: payload.invitationId })
      }
      if (event.kind === 'call.accepted') {
        const callId = (event.payload as { callId?: string }).callId
        if (callId) void resolveActiveCall(callId)
      }
      if (event.kind === 'call.missed' || event.kind === 'call.ended') {
        const callId = (event.payload as { callId?: string }).callId
        setIncoming((current) => current?.callId === callId ? null : current)
        if (activeRef.current?.callId === callId) {
          closeAudio()
          updateActive(null)
        }
      }
      if (event.kind === 'media.negotiation') {
        const payload = event.payload as MediaNegotiation
        void (async () => {
          const peer = peerRef.current
          const current = activeRef.current
          if (!peer || !current || current.callId !== payload.callId) return
          try {
            peer.setConfiguration({ iceServers: payload.iceServers })
            await peer.setRemoteDescription({ sdp: payload.description, type: payload.descriptionType })
            if (payload.descriptionType === 'offer') {
              const answer = await peer.createAnswer()
              await peer.setLocalDescription(answer)
              await sendSygSphereCommunicationsCommand(directMediaAnswerCommand({
                answer: peer.localDescription?.sdp ?? '',
                generation: payload.generation,
                negotiationId: payload.negotiationId,
                peerHandle: payload.peerHandle,
              }, 0))
            }
            if (activeRef.current?.callId === payload.callId) updateActive({ ...activeRef.current, state: 'live' })
            setNotice('Secure audio is connected.')
          } catch {
            setNotice('Audio could not connect. You can try joining the call again.')
          }
        })()
      }
      if (event.kind === 'media.closed') {
        const callId = (event.payload as { callId?: string }).callId
        if (activeRef.current?.callId === callId) {
          closeAudio()
          updateActive(null)
        }
      }
      publishEvent(event)
    }
    const connect = async () => {
      try {
        const bootstrap = await bootstrapSygSphereCommunications()
        if (disposed) return
        socketRef.current?.close(1000, 'Replacing communications connection.')
        socketRef.current = openSygSphereCommunicationsSocket(bootstrap, {
          onAuthenticated: () => {
            retryDelayRef.current = 1_000
            publishRuntime('ready')
          },
          onEvent,
          onUnavailable: retry,
        })
        if (refreshRef.current === null) {
          refreshRef.current = window.setInterval(() => {
            void refreshSygSphereCommunicationsAuthorization().catch(retry)
          }, 60_000)
        }
      } catch {
        retry()
      }
    }
    void connect()
    return () => {
      disposed = true
      clearTimers()
      socketRef.current?.close(1000, 'Leaving communications.')
      socketRef.current = null
      closeAudio()
      publishRuntime('unavailable')
    }
  }, [enabled])

  const respond = async (kind: 'call.accept' | 'call.decline') => {
    if (!incoming) return
    const current = incoming
    try {
      const outcome = await sendSygSphereCommunicationsCommand(directCallInvitationCommand(kind, current.invitationId, 0))
      if (outcome === 'accepted') {
        setIncoming(null)
        if (kind === 'call.accept') void resolveActiveCall(current.callId)
      }
    } catch {
      // Keep the card available until it expires or the employee chooses
      // again; no provider or database detail is ever shown here.
    }
  }

  const joinAudio = async () => {
    if (!active || peerRef.current || !navigator.mediaDevices?.getUserMedia) {
      if (!navigator.mediaDevices?.getUserMedia) setNotice('This browser does not support secure audio calls.')
      return
    }
    updateActive({ ...active, state: 'joining' })
    setNotice('Preparing your microphone…')
    try {
      const iceServers = await prepareSygSphereDirectAudio(active.callId, active.conversationReference)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
        video: false,
      })
      const peer = new RTCPeerConnection({ iceServers: [...iceServers] })
      peerRef.current = peer
      localStreamRef.current = stream
      peer.ontrack = (event) => {
        const remote = event.streams[0] ?? new MediaStream([event.track])
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remote
          void remoteAudioRef.current.play().catch(() => undefined)
        }
      }
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') setNotice('Audio is reconnecting. Keep this call open and try joining again if needed.')
      }
      for (const track of stream.getTracks()) peer.addTrack(track, stream)
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      const outcome = await startSygSphereDirectAudio(active.callId, active.conversationReference, peer.localDescription?.sdp ?? '')
      if (outcome !== 'accepted') throw new Error('Audio is unavailable.')
    } catch (error) {
      closeAudio()
      if (activeRef.current?.callId === active.callId) updateActive({ ...activeRef.current, state: 'connected' })
      setNotice(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Microphone access is needed to join this call. You can allow it and try again.'
        : 'Audio could not be started. Please try again.')
    }
  }

  const endCall = async () => {
    if (!active) return
    closeAudio()
    try { await sendSygSphereCommunicationsCommand(directCallEndCommand('call.end', active.callId, 0)) } catch { /* The server expiry path also closes local media. */ }
    updateActive(null)
    setNotice('Call ended.')
  }

  const toggleMute = () => {
    const stream = localStreamRef.current
    if (!stream) return
    const next = !muted
    for (const track of stream.getAudioTracks()) track.enabled = !next
    setMuted(next)
  }

  if (!incoming && !active) return null
  return <aside className="sphere-toast sphere-call-toast" aria-label={incoming ? 'Incoming SygSphere call' : 'SygSphere call'} role="dialog">
    <Phone aria-hidden="true" size={22} />
    <div><strong>{incoming ? 'Incoming SygSphere call' : active?.state === 'live' ? 'Secure audio call' : 'SygSphere call connected'}</strong><span>{incoming ? 'Answer to join the secure call, or decline to keep working.' : notice || 'Join audio when you are ready.'}</span></div>
    <div className="sphere-call-toast__actions">
      {incoming ? <><button className="sphere-primary" type="button" onClick={() => void respond('call.accept')}><Phone size={16} /> Answer</button><button type="button" aria-label="Decline call" onClick={() => void respond('call.decline')}><PhoneOff size={16} /> Decline</button></> : active ? <>
        {active.state === 'live' ? <button type="button" onClick={toggleMute} aria-pressed={muted}>{muted ? <MicOff size={16} /> : <Mic size={16} />}{muted ? 'Unmute' : 'Mute'}</button> : <button className="sphere-primary" type="button" onClick={() => void joinAudio()} disabled={active.state === 'joining'}><Mic size={16} /> {active.state === 'joining' ? 'Joining…' : 'Join audio'}</button>}
        <button type="button" aria-label="End call" onClick={() => void endCall()}><PhoneOff size={16} /> End</button>
      </> : null}
      {incoming && callAlertBlocked ? <button type="button" onClick={() => void enableCallAlert()}>Enable call sound</button> : null}
    </div>
    <audio ref={remoteAudioRef} autoPlay />
  </aside>
}

import { Check, ChevronRight } from 'lucide-react'

export function SupportProgress({ labels, current, label }: { labels: readonly string[]; current: number; label: string }) {
  return <ol className="support-progress" aria-label={label}>
    {labels.map((text, index) => <li key={index} className={index === current ? 'is-current' : index < current ? 'is-complete' : 'is-upcoming'} aria-current={index === current ? 'step' : undefined}>
      <div className="support-progress__step"><span className="support-progress__marker" aria-hidden="true">{index < current ? <Check size={16} /> : index + 1}</span><strong>{text}</strong></div>
      {index < labels.length - 1 ? <span className="support-progress__connector" aria-hidden="true"><ChevronRight size={17} /></span> : null}
      <span className="visually-hidden">{index === current ? 'Current step' : index < current ? 'Completed' : 'Upcoming'}</span>
    </li>)}
  </ol>
}

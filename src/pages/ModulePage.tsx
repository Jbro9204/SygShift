import { LockKeyhole } from 'lucide-react'

interface ModulePageProps {
  eyebrow: string
  title: string
  description: string
}

export function ModulePage({ eyebrow, title, description }: ModulePageProps) {
  return (
    <div className="page page--module">
      <section className="page-intro">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="page-summary">{description}</p>
        </div>
      </section>
      <section className="module-foundation" aria-labelledby="module-foundation-heading">
        <div className="module-foundation-icon">
          <LockKeyhole aria-hidden="true" size={30} />
        </div>
        <div>
          <h2 id="module-foundation-heading">Protected by the application foundation</h2>
          <p>
            This module will open after its database rules, permissions, history, and source-data checks are complete.
          </p>
        </div>
      </section>
    </div>
  )
}

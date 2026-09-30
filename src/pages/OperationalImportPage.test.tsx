import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EmployeeEditor, OperationalImportPage } from './OperationalImportPage'

const supervisorCandidate = {
  candidate_id: '10000000-0000-4000-8000-000000000001',
  candidate_key: 'employee:supervisor',
  current_mapping: null,
  mapping_decided_at: null,
  source_payload: { name: 'Existing Supervisor', roleCandidate: 'supervisor' },
  total_count: 1,
}

describe('operational import page', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
  })

  it('explains the verified mapping scope without exposing private records', () => {
    render(<OperationalImportPage />)

    expect(screen.getByRole('heading', { name: 'Operational import' })).toBeVisible()
    expect(screen.getByText('The current schedule is reduced to a manageable review.')).toBeVisible()
    expect(screen.getByText('963')).toBeVisible()
    expect(screen.getByText('Ready to connect the protected mapping workspace')).toBeVisible()
  })

  it('preserves an unauthorized imported role and requires an explicit allowed choice before save', () => {
    const onSave = vi.fn()
    render(
      <EmployeeEditor
        actor={{ permissions: ['imports.operations.manage'], role: 'supervisor' }}
        item={supervisorCandidate}
        onClose={vi.fn()}
        onSave={onSave}
        pending={false}
      />,
    )

    const role = screen.getByRole('combobox', { name: /Primary workforce role/ })
    expect(role).toHaveValue('supervisor')
    expect(screen.getByText(/Supervisor remains selected but cannot be saved/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save Directory mapping' })).toBeDisabled()

    fireEvent.change(role, { target: { value: 'guard' } })
    expect(screen.getByRole('button', { name: 'Save Directory mapping' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save Directory mapping' }))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ role: 'guard' }))
  })
})

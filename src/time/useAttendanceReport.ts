import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { reportAttendanceIssue } from '../data/timekeeping'

export type AttendanceIssueType = 'called_in_sick' | 'call_off'

export function useAttendanceReport(defaultDate?: string) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [eventType, setEventType] = useState<AttendanceIssueType>('called_in_sick')
  const [selectedShiftId, setSelectedShiftId] = useState('')
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const date = selectedDate ?? defaultDate ?? ''
  const mutation = useMutation({
    mutationFn: () => reportAttendanceIssue({
      eventType,
      note,
      operationalDate: selectedShiftId ? null : date,
      shiftId: selectedShiftId || null,
    }),
    onSuccess: async () => {
      setNote('')
      setOpen(false)
      setSelectedShiftId('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['my-time-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['my-time-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-payroll-accountability'] }),
      ])
    },
  })

  return {
    mutation,
    open,
    setOpen,
    form: {
      date,
      eventType,
      note,
      onChangeDate: setSelectedDate,
      onChangeEventType: setEventType,
      onChangeNote: setNote,
      onChangeShiftId: setSelectedShiftId,
      onSubmit: mutation.mutate,
      pending: mutation.isPending,
      selectedShiftId,
    },
  }
}

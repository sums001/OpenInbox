import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/form';
import { Dialog } from '../../components/ui/overlay';

const pad = (n: number) => String(n).padStart(2, '0');

// A date and a time in the future, for Send later and Snooze.
export function PickTimeDialog({
  open,
  onClose,
  onPick,
  title,
  description,
  confirmLabel,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (at: number) => void;
  title: string;
  description?: string;
  confirmLabel: string;
}) {
  const [date, setDate] = useState('');
  const [time, setTime] = useState('08:00');
  useEffect(() => {
    if (!open) return;
    const t = new Date(Date.now() + 86_400_000);
    setDate(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`);
    setTime('08:00');
  }, [open]);
  const at = date && time ? new Date(`${date}T${time}`).getTime() : NaN;
  const valid = Number.isFinite(at) && at > Date.now() + 60_000;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => {
              onClose();
              onPick(at);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_130px] gap-2.5">
        <Field label="Date">
          <div className="relative">
            <CalendarClock className="pointer-events-none absolute top-1/2 left-2.5 h-[15px] w-[15px] -translate-y-1/2 text-faint" />
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="pl-8" />
          </div>
        </Field>
        <Field label="Time">
          <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
      </div>
      {date && time && !valid && <p className="mt-2 text-xs text-danger">Pick a time at least a minute from now.</p>}
    </Dialog>
  );
}

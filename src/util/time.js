import dayjs from 'dayjs';
import utc from 'dayjs-plugin-utc';
import tz from 'dayjs-plugin-timezone';
dayjs.extend(utc); dayjs.extend(tz);

export const toUtcDay = (d = dayjs().utc()) => d.utc().format('YYYY-MM-DD');
export const toHour = (d = dayjs().utc()) => d.utc().hour();

export const parseDate = (str) => dayjs.utc(str, 'YYYY-MM-DD', true);
export const nowUtc = () => dayjs.utc();

export function hoursArray() { return Array.from({length:24}, (_,i)=>i); }

export function humanSlot(dateStr, hour) {
  const start = dayjs.utc(`${dateStr} ${String(hour).padStart(2,'0')}:00`, 'YYYY-MM-DD HH:mm');
  const end = start.add(1, 'hour');
  return `${start.format('MMM D HH:00')}–${end.format('HH:00')} UTC`;
}

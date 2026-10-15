import { Fragment, type ReactNode } from 'react';
import { Pill } from '@/components/ui/Pill';
import { TableWrap, TD, TH } from '@/components/ui/Table';
import type { OutreachRow, OutreachState } from '@/server/outreach-status';

/**
 * The Outreach status screen, read-only: one row per setting, in the order Brandon switches them on. Each row says
 * on, off or can't tell, and what it is still waiting for. "Can't tell" never stands in for off: it means this
 * screen has no way to read that setting, or the service that holds it did not answer. There is no control here,
 * and no configured value, address, list or patient is shown.
 */
const STATE: Record<OutreachState, { label: string; tone: 'positive' | 'slate' | 'warning' }> = {
  on: { label: 'On', tone: 'positive' },
  off: { label: 'Off', tone: 'slate' },
  unknown: { label: 'Can\'t tell', tone: 'warning' },
};

/** Backticked names in the fixed text render as code; nothing else is interpreted. */
function Named({ text }: { text: string }): ReactNode {
  return text.split('`').map((part, index) => index % 2 === 1
    ? <code key={index} className="rounded bg-sunken px-[4px] py-px text-[11.5px]">{part}</code>
    : <Fragment key={index}>{part}</Fragment>);
}

export function OutreachStatusView({ rows }: { rows: readonly OutreachRow[] }) {
  const count = (state: OutreachState) => rows.filter(r => r.state === state).length;
  return (
    <div data-testid="outreach-status">
      <p data-testid="outreach-summary" className="mb-2 text-[12.5px] text-body">
        {count('on')} on · {count('off')} off · {count('unknown')} can&apos;t tell
      </p>
      <p className="mb-3 text-[12px] leading-[1.5] text-subtle">
        &ldquo;Can&apos;t tell&rdquo; means this screen cannot read that setting, or the service that holds it did not answer. It is not the same as off.
        Nothing can be switched from here; the order below is the order in <code className="text-[11.5px]">docs/outreach-go-live.md</code>.
      </p>
      <TableWrap>
        <thead>
          <tr><TH>Step</TH><TH>Setting</TH><TH>Turns on</TH><TH>State</TH><TH>Blocked until</TH></tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id} data-testid="outreach-row" data-row={row.id} data-state={row.state}>
              <TD className="align-top tabular-nums text-subtle">{row.step}</TD>
              <TD className="align-top">
                <div className="font-semibold"><Named text={row.setting} /></div>
                <div className="mt-[2px] text-[11.5px] text-subtle">{row.where}</div>
              </TD>
              <TD className="align-top">{row.turnsOn}</TD>
              <TD className="align-top">
                <Pill tone={STATE[row.state].tone}>{STATE[row.state].label}</Pill>
                <div data-testid="outreach-reading" className="mt-[4px] max-w-[300px] text-[11.5px] leading-[1.45] text-subtle">{row.reading}</div>
              </TD>
              <TD className="align-top">
                <div>{row.blockedUntil}</div>
                <div className="mt-[2px] text-[11.5px] text-subtle">Who: {row.who}</div>
              </TD>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </div>
  );
}

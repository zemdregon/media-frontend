// T3.7: the copies radiogroup and the "why this copy" callout render every LLD-API reason code.
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { REASON_CODES, type ItemCopy } from '@cinewren/shared';
import { REASON_TEXT } from '../lib/reasons';
import { copyRow } from '../test-utils';
import { CopiesPicker, WhyCallout, copyKey } from './CopiesPicker';

const copies: ItemCopy[] = [
  copyRow({
    sourceId: 'a',
    selected: true,
    reasons: ['direct_play', 'highest_playable_resolution'],
  }),
  copyRow({
    sourceId: 'b',
    serverName: "Dad's Plex",
    serverType: 'plex',
    resolution: { width: 3840, height: 2160, label: '2160p' },
    hdr: 'hdr10',
    audio: [{ codec: 'aac', channels: 6, language: 'en' }],
    sizeBytes: 38_600_000_000,
    expectedPlayability: 'transcode',
    reasons: ['transcode_video_codec', 'hdr_unsupported', 'resolution_exceeds_device'],
  }),
  copyRow({
    sourceId: 'c',
    serverName: 'Seedbox',
    serverType: 'emby',
    serverStatus: 'unreachable',
    sizeBytes: null,
    expectedPlayability: 'unavailable',
    reasons: ['server_unreachable'],
  }),
];

function Harness({ onChange = () => undefined }: { onChange?: (k: string) => void }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <>
      <h2 id="h">Copies</h2>
      <CopiesPicker
        copies={copies}
        value={value}
        labelledBy="h"
        onChange={(k) => {
          setValue(k);
          onChange(k);
        }}
      />
    </>
  );
}

it('renders a radiogroup with one radio per copy, the BEST badge, and per-device status', () => {
  render(<Harness />);
  const group = screen.getByRole('radiogroup', { name: 'Copies' });
  const radios = within(group).getAllByRole('radio');
  expect(radios).toHaveLength(3);
  expect(radios[0]).toHaveAttribute('aria-checked', 'true');
  expect(radios[0]).toHaveTextContent('Best copy');
  expect(within(radios[0] as HTMLElement).getByText('BEST')).toBeInTheDocument();
  expect(radios[0]).toHaveTextContent('JELLYFIN · Online');
  expect(radios[0]).toHaveTextContent('FLAC 2.0');
  expect(radios[0]).toHaveTextContent('14.2 GB');
  expect(radios[0]).toHaveTextContent('Direct play');
  expect(radios[1]).toHaveTextContent('HDR10');
  expect(radios[1]).toHaveTextContent('AAC 5.1');
  expect(radios[1]).toHaveTextContent('Needs transcode');
  expect(radios[2]).toHaveTextContent('Unavailable');
  expect(radios[2]).toHaveTextContent('Unknown');
  expect(within(radios[1] as HTMLElement).queryByText('BEST')).not.toBeInTheDocument();
});

it('moves the selection with arrow keys using a roving tabindex, and updates the callout', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<Harness onChange={onChange} />);
  const radios = screen.getAllByRole('radio');
  expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  radios[0]?.focus();
  await user.keyboard('{ArrowDown}');
  expect(onChange).toHaveBeenLastCalledWith(copyKey(copies[1] as ItemCopy));
  expect(radios[1]).toHaveFocus();
  expect(radios[1]).toHaveAttribute('aria-checked', 'true');
  expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  expect(screen.getByText("Dad's Plex: 2160p, needs a transcode")).toBeInTheDocument();
  await user.keyboard('{ArrowDown}{ArrowDown}');
  expect(radios[0]).toHaveFocus(); // wraps around
  await user.click(radios[2] as HTMLElement);
  expect(screen.getByText('Seedbox: 1080p, unavailable right now')).toBeInTheDocument();
  expect(screen.getByText(/not answering right now/)).toBeInTheDocument();
});

it('the callout is a polite live region', () => {
  render(<WhyCallout copy={copies[0] as ItemCopy} />);
  const live = screen.getByText('Basement NAS: 1080p, direct play').closest('[aria-live]');
  expect(live).toHaveAttribute('aria-live', 'polite');
});

it.each(REASON_CODES)('renders the plain-language sentence for reason code %s', (code) => {
  render(<WhyCallout copy={copyRow({ sourceId: 'x', reasons: [code] })} />);
  expect(screen.getByText(REASON_TEXT[code])).toBeInTheDocument();
});

it('renders reasons in order, ignores unknown codes and has a fallback without any', () => {
  const { rerender } = render(
    <WhyCallout
      copy={copyRow({ sourceId: 'x', reasons: ['future_code', 'direct_play', 'failover'] as unknown as ItemCopy['reasons'] })}
    />,
  );
  expect(
    screen.getByText(`${REASON_TEXT.direct_play} ${REASON_TEXT.failover}`),
  ).toBeInTheDocument();
  rerender(
    <WhyCallout copy={copyRow({ sourceId: 'x', reasons: [], expectedPlayability: null })} />,
  );
  expect(screen.getByText(/checks this against your device/)).toBeInTheDocument();
  expect(screen.getByText('Basement NAS: 1080p, not checked on this device')).toBeInTheDocument();
});

it('has a sentence for every code in the reasons table', () => {
  expect(Object.keys(REASON_TEXT).sort()).toEqual([...REASON_CODES].sort());
});

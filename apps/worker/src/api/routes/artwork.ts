import { Hono } from 'hono';
import { ARTWORK_SLOTS, type ArtworkSlot } from '@cinewren/shared';
import { serveArtwork } from '../../artwork/proxy';
import type { AppEnv } from '../context';
import { AppError } from '../errors';

const TAG = /^[A-Za-z0-9._~-]{1,128}$/;

const tagOf = (raw: string | undefined) => (raw !== undefined && TAG.test(raw) ? raw : undefined);

/**
 * Artwork (FR-CAT-009, ADR-0012). The people and collection routes are registered first so that
 * `/artwork/people/{id}` is not read as an item called "people".
 */
export const artwork = new Hono<AppEnv>()
  .get('/people/:id', (c) =>
    serveArtwork(c, { kind: 'person', id: c.req.param('id') }, tagOf(c.req.query('v'))),
  )
  .get('/collections/:id', (c) =>
    serveArtwork(c, { kind: 'collection', id: c.req.param('id') }, tagOf(c.req.query('v'))),
  )
  .get('/:itemId/:slot', (c) => {
    const slot = c.req.param('slot');
    if (!(ARTWORK_SLOTS as readonly string[]).includes(slot)) {
      throw new AppError('VALIDATION_FAILED', 'The request was invalid.', { fields: ['kind'] });
    }
    return serveArtwork(
      c,
      { kind: 'item', id: c.req.param('itemId'), slot: slot as ArtworkSlot },
      tagOf(c.req.query('v')),
    );
  });

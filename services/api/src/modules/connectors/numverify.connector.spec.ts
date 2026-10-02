import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config } from '../../config';
import { NumverifyConnector } from './web.connectors';
import { TransformInput } from './connector.types';

const realFetch = globalThis.fetch;
const realKey = config.numverifyApiKey;

const phoneInput = (over: Partial<TransformInput> = {}): TransformInput => ({
  entityId: 'e1',
  caseId: 'c1',
  type: 'PHONE',
  value: '+6281234567890',
  properties: { e164: '+6281234567890', country_code: 'ID' },
  context: { organizations: [], cities: [], verifiedPhones: [], verifiedEmails: [] },
  ...over,
});

/** Serve a fixed JSON body as the next fetch response and capture the URL that was called. */
const stubFetch = (body: unknown) => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
};

describe('NumverifyConnector', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    config.numverifyApiKey = realKey;
  });

  it('throws when no API key is configured', async () => {
    config.numverifyApiKey = '';
    await assert.rejects(() => new NumverifyConnector().run(phoneInput()), /NUMVERIFY_API_KEY is not configured/);
  });

  it('reports requiresCredential based on the key', () => {
    const c = new NumverifyConnector();
    config.numverifyApiKey = '';
    assert.equal(c.def.requiresCredential(), true);
    config.numverifyApiKey = 'k';
    assert.equal(c.def.requiresCredential(), false);
  });

  it('maps a valid number to carrier, country, area and line-type attributes', async () => {
    config.numverifyApiKey = 'SECRET_TEST_KEY';
    const calls = stubFetch({
      valid: true,
      number: '6281234567890',
      international_format: '+6281234567890',
      country_code: 'ID',
      country_name: 'Indonesia',
      location: 'Jakarta',
      carrier: 'PT Telekomunikasi Selular',
      line_type: 'mobile',
    });

    const out = await new NumverifyConnector().run(phoneInput());

    // Request carried the key and the number.
    assert.match(calls[0], /access_key=SECRET_TEST_KEY/);
    assert.match(calls[0], /number=%2B6281234567890/);

    const carrier = out.entities.find((e) => e.type === 'ORGANIZATION');
    assert.equal(carrier?.value, 'PT Telekomunikasi Selular');
    const country = out.entities.find((e) => e.type === 'LOCATION' && e.properties?.level === 'country');
    assert.equal(country?.value, 'Indonesia');
    const area = out.entities.find((e) => e.type === 'LOCATION' && e.properties?.level === 'area');
    assert.equal(area?.value, 'Jakarta');
    assert.ok(out.attributes?.some((a) => a.key === 'line_type' && a.value === 'mobile'));
    assert.ok(out.attributes?.some((a) => a.key === 'numverify_valid' && a.value === 'true'));
    // Every relationship points back to the input phone.
    assert.ok(out.relationships.every((r) => r.from === 'input'));
  });

  it('records an invalid number without emitting entities', async () => {
    config.numverifyApiKey = 'k';
    stubFetch({ valid: false, number: '123', country_code: '', line_type: '' });
    const out = await new NumverifyConnector().run(phoneInput());
    assert.equal(out.entities.length, 0);
    assert.ok(out.attributes?.some((a) => a.key === 'numverify_valid' && a.value === 'false'));
  });

  it('surfaces numverify error bodies (HTTP 200 with success:false)', async () => {
    config.numverifyApiKey = 'k';
    stubFetch({ success: false, error: { code: 101, info: 'invalid access key' } });
    await assert.rejects(() => new NumverifyConnector().run(phoneInput()), /invalid access key/);
  });
});

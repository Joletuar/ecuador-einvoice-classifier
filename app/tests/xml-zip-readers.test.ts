import { describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { readInvoiceXml, exactAmount } from '../src/workers/xmlInvoiceReader'
import {
  readZipInvoices,
  type ZipReadState,
} from '../src/workers/zipInvoiceReader'
import {
  ProcessingCancelled,
  validateLimits,
} from '../src/workers/processingLimits'
import {
  directXml,
  encoded,
  immediateControl,
  limits,
  collect,
} from './fixtures/workerFixtures'

describe('Worker XML extraction', () => {
  it.each(['direct', 'wrapped'])(
    'retains buyer identity and issuer RUC as text in %s namespaced XML',
    async (container) => {
      const xml = directXml()
        .replace(
          '<infoTributaria>',
          '<infoTributaria><ruc> 0012345678001 </ruc>',
        )
        .replace(
          '<infoFactura>',
          '<infoFactura><razonSocialComprador> Ana &amp; José </razonSocialComprador><identificacionComprador> 00AB-09/XYZ </identificacionComprador>',
        )
        .replace(/(<\/?)(\w+)(?=>)/g, '$1s:$2')
        .replace('<s:factura>', '<s:factura xmlns:s="urn:sri">')
      const content =
        container === 'wrapped'
          ? `<a:autorizacion xmlns:a="urn:sri"><a:comprobante><![CDATA[${xml}]]></a:comprobante></a:autorizacion>`
          : xml
      const invoice = await readInvoiceXml(
        encoded(content, 1),
        'invoice',
        limits,
        immediateControl,
      )

      expect(invoice.issuer.ruc).toBe('0012345678001')
      expect(invoice.buyer).toEqual({
        name: 'Ana & José',
        identification: '00AB-09/XYZ',
      })
      expect(invoice.issues).toEqual([])
    },
  )

  it.each(['', ' ', '123', 'x'.repeat(49), '1'.repeat(50)])(
    'rejects missing or malformed access key: %s',
    async (key) => {
      const xml = directXml().replace(
        /<claveAcceso>.*?<\/claveAcceso>/,
        key ? `<claveAcceso>${key}</claveAcceso>` : '',
      )

      await expect(
        readInvoiceXml(encoded(xml), 'invoice', limits, immediateControl),
      ).rejects.toThrow('clave de acceso')
    },
  )

  it('trims the access key without losing leading zeros', async () => {
    const key = '0'.repeat(48) + '1'
    const xml = directXml().replace(
      `<claveAcceso>${key}</claveAcceso>`,
      `<claveAcceso> ${key} </claveAcceso>`,
    )

    expect(
      (await readInvoiceXml(encoded(xml), 'invoice', limits, immediateControl))
        .accessKey,
    ).toBe(key)
  })

  it('keeps missing and blank optional identities unavailable without adding issues', async () => {
    const missing = await readInvoiceXml(
      encoded(directXml()),
      'invoice',
      limits,
      immediateControl,
    )
    const blank = await readInvoiceXml(
      encoded(
        directXml()
          .replace('<infoTributaria>', '<infoTributaria><ruc> </ruc>')
          .replace(
            '<infoFactura>',
            '<infoFactura><razonSocialComprador/><identificacionComprador> </identificacionComprador>',
          ),
      ),
      'invoice',
      limits,
      immediateControl,
    )

    expect(missing.issuer.ruc).toBeNull()
    expect(missing.buyer).toEqual({ name: null, identification: null })
    expect(blank).toEqual(missing)
    expect(missing.issues).toEqual([])
  })

  it('preserves original Unicode, whitespace, entities, net and invoice total independently', async () => {
    const invoice = await readInvoiceXml(
      encoded(directXml(), 1),
      'invoice',
      limits,
      immediateControl,
    )

    expect(invoice.concepts[0].description).toBe('  ARROZ & café  ')
    expect(invoice.concepts[0].netAmount.decimal).toBe('10.00')
    expect(invoice.total.decimal).toBe('11.50')
    expect(invoice.date.iso).toBe('2024-02-29')
    expect(invoice.number).toEqual({
      establishment: '001',
      pointOfIssue: '002',
      sequential: '000000123',
    })
  })

  it('unwraps CDATA and text-escaped authorizations with namespaced factura', async () => {
    const xml = directXml()
      .replace('<factura>', '<f:factura xmlns:f="urn:sri">')
      .replace('</factura>', '</f:factura>')
    const cdata = `<a:autorizacion xmlns:a="urn:sri"><a:comprobante><![CDATA[${xml}]]></a:comprobante></a:autorizacion>`
    const escaped = `<autorizacion><comprobante>${xml.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</comprobante></autorizacion>`

    const first = await readInvoiceXml(
      encoded(cdata),
      'invoice',
      limits,
      immediateControl,
    )
    const second = await readInvoiceXml(
      encoded(escaped),
      'invoice',
      limits,
      immediateControl,
    )

    expect(second).toEqual(first)
  })

  it('distinguishes absent, empty, whitespace and CDATA descriptions', async () => {
    const xml = directXml(
      '<detalle/><detalle><descripcion/></detalle><detalle><descripcion>   </descripcion></detalle><detalle><descripcion><![CDATA[ café ]]></descripcion></detalle>',
    )

    const invoice = await readInvoiceXml(
      encoded(xml),
      'invoice',
      limits,
      immediateControl,
    )

    expect(
      invoice.concepts.map((concept) => [
        concept.descriptionPresent,
        concept.description,
      ]),
    ).toEqual([
      [false, null],
      [true, ''],
      [true, '   '],
      [true, ' café '],
    ])
    expect(invoice.concepts.map((concept) => concept.position)).toEqual([
      0, 1, 2, 3,
    ])
  })

  it('keeps classifiable concepts when presentation data is missing or invalid', async () => {
    const invoice = await readInvoiceXml(
      encoded(
        '<factura><infoTributaria><claveAcceso>0000000000000000000000000000000000000000000000001</claveAcceso></infoTributaria><infoFactura><fechaEmision>31/02/2024</fechaEmision><moneda>DOL</moneda></infoFactura><detalles><detalle><descripcion>ARROZ</descripcion></detalle></detalles></factura>',
      ),
      'invoice',
      limits,
      immediateControl,
    )

    expect(invoice.date.iso).toBeNull()
    expect(invoice.currency).toEqual({ raw: 'DOL', code: null })
    expect(invoice.issuer.legalName).toBeNull()
    expect(invoice.concepts[0].description).toBe('ARROZ')
    expect(invoice.issues.map((issue) => issue.code)).toContain(
      'UNKNOWN_CURRENCY',
    )
  })

  it.each([
    '<!DOCTYPE factura><factura/>',
    '<factura><x></factura>',
    '<factura>&unknown;</factura>',
    '<factura>\u0000</factura>',
  ])(
    'rejects invalid XML without weakening the model policy: %s',
    async (xml) => {
      await expect(
        readInvoiceXml(encoded(xml), 'invoice', limits, immediateControl),
      ).rejects.toHaveProperty('detail.code', 'INVALID_XML')
    },
  )

  it('rejects unsupported encodings and malformed UTF-8 with an explicit reason', async () => {
    await expect(
      readInvoiceXml(
        encoded('<?xml version="1.0" encoding="ISO-8859-1"?><factura/>'),
        'invoice',
        limits,
        immediateControl,
      ),
    ).rejects.toHaveProperty('detail.code', 'UNSUPPORTED_XML')

    const invalid = async function* () {
      yield new Uint8Array([0xff])
    }

    await expect(
      readInvoiceXml(invalid(), 'invoice', limits, immediateControl),
    ).rejects.toHaveProperty('detail.code', 'INVALID_XML')
  })

  it('bounds decoded parser work even when the inflater emits one large chunk', async () => {
    const yieldWork = vi.fn(async () => undefined)
    const bytes = new TextEncoder().encode(directXml())
    const chunks = async function* () {
      yield bytes
    }

    await readInvoiceXml(
      chunks(),
      'invoice',
      { ...limits, chunkBytes: 16 },
      { cancelled: () => false, yield: yieldWork },
    )

    expect(yieldWork.mock.calls.length).toBe(Math.ceil(bytes.length / 16))

    await expect(
      readInvoiceXml(chunks(), 'invoice', limits, {
        cancelled: () => true,

        yield: yieldWork,
      }),
    ).rejects.toBeInstanceOf(ProcessingCancelled)
  })

  it('preserves exact declarations while canonicalizing decimal spelling only', () => {
    expect(exactAmount(' +000.0100 ')).toEqual({
      raw: ' +000.0100 ',
      decimal: '0.0100',
    })
    expect(exactAmount('-000.1')).toEqual({ raw: '-000.1', decimal: '-0.1' })
    expect(exactAmount('1e3').decimal).toBeNull()
  })
})

describe('Worker streaming ZIP', () => {
  function archive() {
    return new File(
      [
        zipSync({
          'root.xml': strToU8(directXml()),
          'deep/sub/second.XML': strToU8('<broken>'),
          'paper.pdf': strToU8('pdf'),
          'nested.zip': new Uint8Array([1, 2]),
        }),
      ],
      'invoices.zip',
    )
  }

  const state = (): ZipReadState => ({ knownXml: 0, omissions: [] })

  it('keeps original entry ordinals and paths, skipping nested archives and other formats', async () => {
    const summary = state()

    const entries = await collect(
      readZipInvoices(
        archive(),
        { mode: 'initial' },
        limits,
        immediateControl,
        summary,
      ),
    )

    expect(entries.map((entry) => [entry.entryIndex, entry.entryPath])).toEqual(
      [
        [0, 'root.xml'],
        [1, 'deep/sub/second.XML'],
      ],
    )
    expect(summary.knownXml).toBe(2)
    expect(summary.omissions.map((entry) => entry.reason)).toEqual([
      'unsupported_file',
      'nested_zip',
    ])
  })

  it('excludes saved and permanently failed siblings, leaving undiscovered entries eligible', async () => {
    const entries = await collect(
      readZipInvoices(
        archive(),
        {
          mode: 'retry',
          settledEntries: [
            {
              entryIndex: 0,
              entryPath: 'root.xml',
              status: 'saved',
              invoiceId: 'saved',
            },
          ],
        },
        limits,
        immediateControl,
        state(),
      ),
    )

    expect(entries.map((entry) => entry.entryPath)).toEqual([
      'deep/sub/second.XML',
    ])
  })

  it('checks actual expanded bytes, input size, archive entry count and XML size', async () => {
    for (const restricted of [
      { ...limits, maxExpandedBytes: 20 },
      { ...limits, maxInputBytes: 10 },
      { ...limits, maxZipEntries: 1 },
      { ...limits, maxXmlBytes: 20 },
    ]) {
      await expect(
        collect(
          readZipInvoices(
            archive(),
            { mode: 'initial' },
            restricted,
            immediateControl,
            state(),
          ),
        ),
      ).rejects.toHaveProperty('detail.code', 'LIMIT_EXCEEDED')
    }
  })

  it('handles the minimum compressed feed size and rejects smaller or missing limits explicitly', async () => {
    const entries = await collect(
      readZipInvoices(
        archive(),
        { mode: 'initial' },
        { ...limits, chunkBytes: 4 },
        immediateControl,
        state(),
      ),
    )

    expect(entries).toHaveLength(2)
    expect(() => validateLimits({ ...limits, chunkBytes: 3 })).toThrow()

    const { batchSize: omitted, ...missing } = limits

    expect(omitted).toBeGreaterThan(0)
    expect(() => validateLimits(missing as typeof limits)).toThrow()
  })

  it('rejects garbage and truncated archives', async () => {
    for (const file of [new File(['bad'], 'bad.zip'), archive().slice(0, 40)]) {
      await expect(
        collect(
          readZipInvoices(
            file,
            { mode: 'initial' },
            limits,
            immediateControl,
            state(),
          ),
        ),
      ).rejects.toHaveProperty('detail.code', 'INVALID_ZIP')
    }
  })
})

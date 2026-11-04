export interface PrecacheResource {
  url: string
  integrity?: string
  revision?: string | null
}

interface ClassifierResource {
  url: string
  sha256: string
}

export interface ResourceInspection {
  uiComplete: boolean
  classifierComplete: boolean
  invalid: PrecacheResource[]
}

async function responseDigest(response: Response): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', await response.arrayBuffer()),
  )
}

export async function verifyResource(
  response: Response | undefined,
  resource: PrecacheResource,
  classifierSha256?: string,
): Promise<boolean> {
  if (!response || response.status !== 200 || !resource.integrity) {
    return false
  }

  try {
    const bytes = await responseDigest(response)

    const integrity = `sha256-${btoa(String.fromCharCode(...bytes))}`
    const sha256 = [...bytes]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')

    return (
      integrity === resource.integrity &&
      (classifierSha256 === undefined || sha256 === classifierSha256)
    )
  } catch {
    return false
  }
}

export async function inspectResources(options: {
  resources: readonly PrecacheResource[]
  classifier: readonly ClassifierResource[]
  origin: string
  read(url: string): Promise<Response | undefined>
}): Promise<ResourceInspection> {
  const absolute = (url: string) => new URL(url, options.origin).href
  const classifier = new Map(
    options.classifier.map((asset) => [absolute(asset.url), asset.sha256]),
  )

  let uiCount = 0
  let classifierCount = 0
  let uiComplete = true
  let classifierComplete = classifier.size === 9
  const invalid: PrecacheResource[] = []

  for (const resource of options.resources) {
    const url = absolute(resource.url)
    const sha256 = classifier.get(url)

    const valid = await verifyResource(
      await options.read(url),
      resource,
      sha256,
    )

    if (sha256 !== undefined) {
      classifierCount++
      classifierComplete &&= valid
    } else {
      uiCount++
      uiComplete &&= valid
    }

    if (!valid) {
      invalid.push(resource)
    }
  }

  return {
    uiComplete: uiComplete && uiCount > 0,
    classifierComplete:
      classifierComplete && classifierCount === classifier.size,
    invalid,
  }
}

export async function repairResources(options: {
  resources: readonly PrecacheResource[]
  origin: string
  fetch(request: Request): Promise<Response>
  write(url: string, response: Response): Promise<void>
}): Promise<void> {
  for (const resource of options.resources) {
    const url = new URL(resource.url, options.origin)

    if (url.origin !== new URL(options.origin).origin || !resource.integrity) {
      throw new Error('Recurso de aplicación no válido.')
    }

    const response = await options.fetch(
      new Request(url, {
        cache: 'reload',
        credentials: 'same-origin',
        integrity: resource.integrity,
      }),
    )

    if (!(await verifyResource(response.clone(), resource))) {
      throw new Error('El recurso descargado no corresponde a esta versión.')
    }

    await options.write(url.href, response)
  }
}

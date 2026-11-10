import { FileResultStatus } from '../model/processingStatus'
import {
  ActivityOperation,
  ActivityPhase,
  type BatchActivity,
} from '../model/activity'
import { FeedbackTone } from '../../../shared/ui/feedbackTone'
import type { FileProcessingResult } from '../services/processingService'
import { WorkerErrorCode } from '../../../workers/workerProtocol'

export const pendingFileMessage =
  'El procesamiento quedó pendiente y puedes volver a intentarlo.'

const problems = {
  format: {
    message: 'El archivo no tiene un formato de factura válido.',
    zip: 'El ZIP contiene archivos con un formato de factura no válido.',
    partial: 'hay archivos con un formato de factura no válido',
  },
  invoice: {
    message: 'Este archivo no contiene una factura válida.',
    zip: 'El ZIP contiene archivos que no son facturas válidas.',
    partial: 'hay archivos que no contienen facturas válidas',
  },
  data: {
    message: 'La factura tiene datos obligatorios incompletos o inválidos.',
    zip: 'El ZIP contiene facturas con datos obligatorios incompletos o inválidos.',
    partial: 'hay facturas con datos obligatorios incompletos o inválidos',
  },
  emptyInvoice: {
    message: 'La factura no contiene productos o servicios.',
    zip: 'El ZIP contiene facturas sin productos o servicios.',
    partial: 'hay facturas sin productos o servicios',
  },
  zip: {
    message: 'El ZIP está dañado, incompleto o tiene un formato no válido.',
    partial: 'el ZIP está dañado, incompleto o tiene un formato no válido',
  },
  read: {
    message: 'No se pudo leer el contenido de este archivo.',
    partial: 'hay archivos cuyo contenido no se pudo leer',
  },
  size: {
    message: 'El archivo supera el tamaño permitido.',
    partial: 'hay archivos que superan el tamaño permitido',
  },
  expandedSize: {
    message: 'El contenido del ZIP supera el tamaño permitido.',
    partial: 'el contenido del ZIP supera el tamaño permitido',
  },
  entries: {
    message: 'El ZIP contiene más archivos de los permitidos.',
    partial: 'el ZIP contiene más archivos de los permitidos',
  },
  classification: {
    message: 'No se pudo determinar la categoría de la factura.',
    partial: 'hay facturas cuya categoría no se pudo determinar',
  },
  classificationUnavailable: {
    message: 'La clasificación de facturas no está disponible en este momento.',
    partial: 'la clasificación de facturas no está disponible en este momento',
  },
  space: {
    message: 'No hay espacio disponible para guardar las facturas.',
    partial: 'no hay espacio disponible para guardar más facturas',
  },
  storage: {
    message: 'No se pudo confirmar el guardado de las facturas.',
    partial: 'no se pudo confirmar el guardado de todas las facturas',
  },
  noInvoices: {
    message: 'El ZIP no contiene facturas en formato XML.',
    partial: 'hay archivos que no son facturas en formato XML',
  },
  nestedZip: {
    message:
      'El ZIP contiene otros ZIP que deben descomprimirse antes de cargarlos.',
    partial: 'hay otros ZIP que deben descomprimirse antes de cargarlos',
  },
  omitted: {
    message: 'El ZIP contiene archivos que no son facturas en formato XML.',
    partial: 'hay archivos que no son facturas en formato XML',
  },
  unexpected: {
    message: 'No se pudo procesar este archivo por un problema inesperado.',
    partial: 'otros archivos no pudieron procesarse por un problema inesperado',
  },
}

type Problem = keyof typeof problems

function issueProblem(issue: string): Problem | undefined {
  if (issue.endsWith(': ZIP interior omitido.')) {
    return 'nestedZip'
  }

  if (issue.endsWith(': Archivo no XML omitido.')) {
    return 'omitted'
  }

  // Se toma el último código porque el nombre del archivo también puede
  // contener uno, y ninguna ruta debe aparecer en la explicación.
  const diagnostic = [...issue.matchAll(/(?:^|: )([A-Z_]+)(?=: |$)/g)].at(-1)
  const code = diagnostic?.[1]
  const message = diagnostic
    ? issue.slice(diagnostic.index! + diagnostic[0].length + 2)
    : issue

  if (
    message === 'El navegador no dispone de espacio para guardar esta factura.'
  ) {
    return 'space'
  }

  switch (code) {
    case WorkerErrorCode.InvalidXml:
      return message.includes('clave de acceso')
        ? 'data'
        : message.includes('UTF-8')
          ? 'read'
          : 'format'
    case WorkerErrorCode.UnsupportedXml:
      return message.includes('UTF-8') ? 'read' : 'invoice'
    case WorkerErrorCode.EmptyInvoice:
      return 'emptyInvoice'
    case WorkerErrorCode.InvalidZip:
      return 'zip'
    case WorkerErrorCode.ReadFailed:
      return 'read'
    case WorkerErrorCode.LimitExceeded:
      if (message.includes('entradas')) {
        return 'entries'
      }

      if (message.includes('no son válidos')) {
        return undefined
      }

      if (message.includes('bytes descomprimidos')) {
        return 'expandedSize'
      }

      return 'size'
    case WorkerErrorCode.ModelUnavailable:
      return 'classificationUnavailable'
    case WorkerErrorCode.ModelFailed:
    case WorkerErrorCode.NoClassifiedConcepts:
    case WorkerErrorCode.UnavailableTieAmount:
      return 'classification'
    case WorkerErrorCode.WriteFailed:
      return 'storage'
  }

  if (
    message === 'No se pudo confirmar la operación de facturas.' ||
    message === 'No se pudo confirmar la escritura.' ||
    message === 'No se pudo confirmar la escritura de la factura.'
  ) {
    return 'storage'
  }
}

function problemMessage(result: FileProcessingResult): string {
  const frequencies = new Map<Problem, number>()
  const issues = result.issues?.length ? result.issues : [result.message]

  for (const issue of issues) {
    const problem = issueProblem(issue)

    if (problem) {
      frequencies.set(problem, (frequencies.get(problem) ?? 0) + 1)
    }
  }

  const isZip = result.name.toLowerCase().endsWith('.zip')
  const onlyOmissions = issues.every((issue) => {
    const problem = issueProblem(issue)

    return problem === 'omitted' || problem === 'nestedZip'
  })

  const noInvoices =
    isZip &&
    result.status === FileResultStatus.Error &&
    !result.retryable &&
    result.counts?.knownXml === 0 &&
    ((!result.issues?.length && !frequencies.size) || onlyOmissions)

  const primary = noInvoices
    ? 'noInvoices'
    : ([...frequencies].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unexpected')

  const problem = problems[primary]

  if (result.status === FileResultStatus.Added) {
    if (!isZip && primary === 'classification') {
      return 'La factura se guardó, pero no se pudo determinar su categoría.'
    }

    return `Se guardaron algunas facturas, pero ${problem.partial}.`
  }

  return isZip && 'zip' in problem ? problem.zip : problem.message
}

export function fileResultMessage(result: FileProcessingResult): string {
  if (result.status === FileResultStatus.Pending) {
    return pendingFileMessage
  }

  if (result.status === FileResultStatus.Error) {
    return problemMessage(result)
  }

  if (
    result.issues?.length ||
    result.counts?.failedXml ||
    result.counts?.omittedEntries
  ) {
    return problemMessage(result)
  }

  if (result.retryable) {
    return pendingFileMessage
  }

  if (result.status === FileResultStatus.Duplicate) {
    return 'Las facturas de este archivo ya estaban guardadas.'
  }

  return result.invoices.length === 1
    ? 'La factura se guardó correctamente.'
    : 'Las facturas se guardaron correctamente.'
}

export function batchActivityMessage(
  activity: BatchActivity,
): string | undefined {
  if (
    activity.operation === ActivityOperation.Processing &&
    activity.phase === ActivityPhase.Failed &&
    activity.tone !== FeedbackTone.Warning
  ) {
    return 'Hubo un problema al procesar los archivos.'
  }

  return activity.message
}

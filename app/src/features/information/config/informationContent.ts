interface TutorialContent {
  id: string
  title: string
  youtubeVideoId: string
  isExample: boolean
}

interface InformationContent {
  project: {
    title: string
    purpose: string
  }
  author: {
    biography: string
    linkedinUrl: string
  }
  survey: {
    url: string
  }
  tutorials: readonly TutorialContent[]
}

export const informationContent: InformationContent = {
  project: {
    title: '¿De que trata?',
    purpose:
      'Mis Facturas te permite importar facturas electrónicas ecuatorianas en formato XML o ZIP para clasificar sus conceptos mediante aprendizaje automático, consultar comprobantes, revisar sus detalles y corregir las categorías asignadas. Todo el procesamiento se realiza en el navegador de forma local, donde también se almacenan los resultados para permitir su consulta sin conexión a Internet.',
  },
  author: {
    biography:
      'Soy Johan Tuarez, desarrollador de software especializado en desarrollo backend y actualmente estudiante de una maestría en Inteligencia Artificial.',
    linkedinUrl: 'https://www.linkedin.com/in/johan-tuarez',
  },
  survey: {
    url: 'https://forms.gle/Qwc59kKgxjT16sxz9',
  },
  tutorials: [
    {
      id: 'download-xml',
      title: '¿Cómo descargar mis facturas electrónicas en formato XML?',
      youtubeVideoId: 'LtLUlyGpfyo',
      isExample: false,
    },
    {
      id: 'use-invoices',
      title: '¿Cómo utilizar Mis Facturas para clasificar los comprobantes?',
      youtubeVideoId: '0UXHW4QJKPo',
      isExample: false,
    },
  ],
}

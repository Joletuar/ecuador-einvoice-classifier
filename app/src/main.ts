import '@fontsource-variable/plus-jakarta-sans'
import './shared/styles/main.css'
import { createApplication } from './app/createApplication'

createApplication({ limits: __STORAGE_LIMITS__ }).app.mount('#app')

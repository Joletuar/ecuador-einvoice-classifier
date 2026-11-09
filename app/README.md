# Ecuador eInvoice Classifier

Aplicación web desarrollada con Vue 3 y TypeScript para importar facturas electrónicas ecuatorianas en formato XML o ZIP, clasificar sus conceptos localmente mediante un modelo ONNX y permitir la consulta y corrección de las categorías asignadas. Los resultados se almacenan en IndexedDB, sin necesidad de un servidor backend.

## Requisitos

Para ejecutar la aplicación se necesita:

- **Bun** instalado.
- Una versión moderna de **Google Chrome o Microsoft Edge**.
- El paquete completo del modelo en `../ml/outputs/models/export/`, que debe incluir `manifest.json`, el archivo ONNX y su runtime.

## Primer arranque

Desde la raíz del proyecto `ecuador-einvoice-classifier/`, ejecuta:

```sh
cd app
bun install --frozen-lockfile
test -f .env || cp .env.example .env
bun run dev
```

Una vez iniciado Vite, abre la dirección que aparece en la terminal, normalmente [http://localhost:5173](http://localhost:5173).

El archivo `.env.example` se copiará a `.env` únicamente si este último todavía no existe.

### Configuración local

La aplicación utiliza las siguientes variables de entorno, que deben contener valores enteros positivos:

| Variable                 | Valor predeterminado | Descripción                                                                                               |
| ------------------------ | -------------------: | --------------------------------------------------------------------------------------------------------- |
| `VITE_STORAGE_MAX_FILES` |              `10000` | Número máximo de archivos exteriores con resultados almacenados, contando cada ZIP como un único archivo. |
| `VITE_STORAGE_MAX_BYTES` |          `104857600` | Tamaño máximo de los registros derivados en JSON canónico, equivalente a 100 MiB.                         |

## Primera importación

1. Accede a la sección **Cargar** y espera a que finalice la preparación del clasificador.
2. Selecciona o arrastra los archivos XML o ZIP y pulsa **Procesar archivos**.
3. Revisa los resultados del procesamiento y accede a **Mis facturas** para consultar los comprobantes.
4. Para modificar una categoría, selecciona la opción correspondiente y confirma con **Guardar** o descarta el cambio mediante **Cancelar**.

La aplicación reconoce las facturas repetidas por la **clave de acceso del XML**, tanto en los datos guardados como dentro del lote, incluidos los XML de un ZIP. Los nombres de archivo se conservan para identificarlos: dos archivos con el mismo nombre pueden contener facturas distintas y renombrar una factura no permite guardarla dos veces. En un ZIP con facturas nuevas y repetidas, se guardan únicamente las nuevas

Las facturas se guardan en la base local `facturas-locales`, con un único esquema inicial que exige la clave de acceso. Los resultados permanecen disponibles al recargar la aplicación en el mismo navegador.

## Compilación y pruebas de producción

Desde el directorio `app/`, ejecuta:

```sh
bun run build
bun run preview
```

### Verificación del funcionamiento sin conexión

Para comprobar el funcionamiento sin conexión, utiliza la versión de producción y sigue estos pasos:

1. Abre la aplicación con conexión a Internet.
2. Espera hasta que se indique que todos los recursos necesarios están disponibles.
3. Cierra la aplicación y desconecta la red.
4. Vuelve a abrirla desde el mismo origen y perfil del navegador.

## Publicación

Para desplegar la aplicación, publica todo el contenido de `dist/`, incluidos el modelo ONNX y su runtime. El alojamiento debe utilizar HTTPS y configurar `index.html` como alternativa para resolver las rutas de navegación.

## Comandos disponibles

| Comando                | Descripción                                                       |
| ---------------------- | ----------------------------------------------------------------- |
| `bun run dev`          | Inicia el servidor de desarrollo con Vite.                        |
| `bun run build`        | Comprueba los tipos y genera la versión de producción en `dist/`. |
| `bun run preview`      | Ejecuta localmente la versión compilada.                          |
| `bun run test`         | Ejecuta las pruebas automatizadas con Vitest.                     |
| `bun run typecheck`    | Comprueba los tipos mediante vue-tsc.                             |
| `bun run lint`         | Analiza el código con ESLint.                                     |
| `bun run format:check` | Verifica el formato del código mediante Prettier.                 |

## Estructura del proyecto

| Directorio      | Descripción                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------- |
| `src/app/`      | Configuración inicial, rutas y estructura principal de la aplicación.                        |
| `src/features/` | Funcionalidades de carga, consulta de facturas y funcionamiento sin conexión.                |
| `src/workers/`  | Procesamiento de XML y ZIP, clasificación y comunicación con el Web Worker.                  |
| `src/shared/`   | Componentes y utilidades reutilizables.                                                      |
| `build/`        | Configuración del empaquetado del modelo y los recursos para el funcionamiento sin conexión. |
| `tests/`        | Pruebas automatizadas de la aplicación.                                                      |

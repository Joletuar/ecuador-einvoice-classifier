# Ecuador eInvoice Classifier

Proyecto para la clasificación automática de conceptos de facturas electrónicas ecuatorianas mediante aprendizaje automático, que incluye notebooks para la preparación de datos, el entrenamiento y la exportación del modelo, junto con una aplicación web que permite ejecutarlo directamente en el navegador.

La aplicación permite importar facturas en formato XML o ZIP, consultar sus conceptos, revisar y corregir las categorías asignadas y almacenar los resultados localmente en IndexedDB. La clasificación se realiza mediante un modelo ONNX, sin necesidad de un servidor backend.

## Categorías de clasificación

Cada concepto de una factura se clasifica en una de las siete categorías establecidas:

- Alimentación
- Salud
- Educación, Arte y Cultura
- Vivienda
- Vestimenta
- Turismo Nacional
- Otros

El clasificador utiliza las descripciones de los productos o servicios y combina una representación textual TF-IDF con regresión logística. Los notebooks permiten preparar los datos, entrenar y evaluar el modelo, y exportarlo junto con los recursos necesarios para su ejecución en el navegador.

## Estructura del proyecto

| Ruta                                      | Descripción                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [`app/`](app/README.md)                   | Aplicación web desarrollada con Vue 3 y TypeScript para importar, clasificar, consultar y corregir facturas. |
| [`ml/notebooks/`](ml/notebooks/README.md) | Notebooks de extracción, análisis exploratorio, preparación, entrenamiento y exportación del modelo.         |
| `ml/data/`                                | Datos de entrada y tablas generadas durante la extracción y preparación.                                     |
| `ml/outputs/models/`                      | Modelo entrenado y paquete ONNX para su ejecución en la aplicación.                                          |
| `ml/outputs/reports/`                     | Informes de procesamiento y evaluación del clasificador.                                                     |
| `ml/outputs/figures/`                     | Gráficos del análisis exploratorio y del entrenamiento.                                                      |

## Ejecución de la aplicación

Para ejecutar la aplicación se requiere Bun, una versión moderna de Chrome o Edge y el paquete completo del clasificador en `ml/outputs/models/export/`, que debe contener `manifest.json`, `concept_pipeline.onnx` y el directorio `runtime/`.

Si el paquete todavía no está disponible, consulta la [guía de notebooks](./ml/notebooks/README.md) para generarlo, ya que la aplicación requiere tanto el modelo ONNX como su motor WebAssembly compatible.

Desde la raíz del proyecto, ejecuta:

```sh
cd app
bun install --frozen-lockfile
test -f .env || cp .env.example .env
bun run dev
```

Una vez iniciado el servidor de desarrollo, abre la dirección indicada por Vite y accede a **Cargar** para preparar el clasificador, seleccionar los archivos XML o ZIP e iniciar su procesamiento mediante **Procesar archivos**. Los resultados estarán disponibles en **Mis facturas**, donde podrás consultar los comprobantes y corregir sus categorías.

La [documentación de la aplicación](app/README.md) incluye información adicional sobre configuración, límites de almacenamiento, pruebas y publicación.

## Preparación y entrenamiento del modelo

El desarrollo del clasificador se organiza en cinco notebooks que permiten completar las siguientes etapas:

1. **Extracción:** recuperar las facturas y sus conceptos etiquetados desde el conjunto de datos.
2. **Análisis exploratorio:** examinar la distribución, calidad y características de las descripciones.
3. **Preparación:** depurar los registros y organizar los datos para el entrenamiento.
4. **Entrenamiento y evaluación:** ajustar el clasificador y analizar su rendimiento.
5. **Exportación:** convertir el modelo a ONNX y preparar el motor compatible con el navegador.

Antes de ejecutar estos procedimientos, consulta la [guía de notebooks](ml/README.md), donde se describen sus dependencias, entradas y salidas.

## Almacenamiento local y funcionamiento sin conexión

Las facturas importadas se procesan directamente en el navegador y sus resultados se conservan localmente, permitiendo consultar los comprobantes y mantener las correcciones realizadas.

La versión de producción permite funcionar sin conexión una vez descargados y preparados todos los recursos necesarios. Para comprobar este comportamiento, ejecuta los siguientes comandos desde `app/`:

```sh
bun run build
bun run preview
```

Después de abrir la aplicación con conexión y completar la preparación inicial, podrás volver a utilizarla sin Internet desde el mismo origen y perfil del navegador, siempre que los recursos y datos almacenados continúen disponibles.

Para más información sobre este procedimiento, consulta la [guía de la aplicación](app/README.md).

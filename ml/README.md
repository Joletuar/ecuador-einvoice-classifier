# Notebooks del clasificador

Estos notebooks permiten preparar los datos de las facturas electrónicas, entrenar y evaluar el clasificador y exportarlo para su integración en la aplicación web. Cada notebook debe ejecutarse siguiendo el orden de sus celdas y verificando los resultados antes de continuar con la siguiente etapa.

## Preparación del entorno

Se requiere Python 3.10 o posterior, Jupyter y el archivo `ml/data/invoices_dataset.zip`, que debe contener las facturas XML anonimizadas y el archivo `labeled_invoices.csv` con las categorías asignadas a sus conceptos.

Desde la raíz del proyecto `ecuador-einvoice-classifier/`, ejecuta los siguientes comandos en una terminal compatible con Bash:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install pandas pyarrow lxml numpy matplotlib seaborn scipy scikit-learn threadpoolctl joblib
python -m pip install spacy torch transformers onnx cmake ninja
python -m spacy download es_core_news_sm
```

El análisis exploratorio utiliza spaCy, PyTorch y Transformers, además del modelo `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`.

Para evitar problemas con las rutas, mantén el directorio de trabajo de Jupyter en la raíz del proyecto, `ml/` o `ml/notebooks/`, especialmente durante la exportación del modelo.

## Orden de ejecución

Los cinco notebooks cubren las etapas de extracción, análisis exploratorio, preparación, entrenamiento y exportación del clasificador.

| Notebook                                                                         | Descripción                                                                                         | Entrada principal                       | Salidas principales                                                                             |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [01. Extracción](./notebooks/01_data_extractor.ipynb)                            | Extrae las facturas y relaciona sus conceptos con las categorías etiquetadas.                       | `ml/data/invoices_dataset.zip`          | `invoices.parquet`, `details.parquet` e informes de incidencias.                                |
| [02. Análisis exploratorio](./notebooks/02_eda.ipynb)                            | Examina la distribución, calidad, duplicados y características de las descripciones.                | Tablas extraídas y ZIP original.        | Resultados en el notebook y figuras en `ml/outputs/figures/eda/`.                               |
| [03. Preparación](./notebooks/03_data_pre-processing.ipynb)                      | Depura los registros, prepara las descripciones y separa las copias excluidas.                      | Tablas extraídas y ZIP original.        | `invoices.parquet`, `model_dataset.parquet` y `excluded_records.parquet` en `ml/data/cleaned/`. |
| [04. Entrenamiento y evaluación](./notebooks/04_model_training_validation.ipynb) | Divide los datos, compara configuraciones de TF-IDF y regresión logística y evalúa el clasificador. | `ml/data/cleaned/model_dataset.parquet` | Modelo `concept_classifier.joblib`, métricas, informes y figuras de entrenamiento.              |
| [05. Exportación ONNX](./notebooks/05_export_onnx.ipynb)                         | Exporta el modelo y su procesamiento textual junto con el motor WebAssembly compatible.             | `concept_classifier.joblib`             | Paquete completo en `ml/outputs/models/export/`.                                                |

Secuencia necesaria para reconstruir el modelo:

**01. Extracción → 03. Preparación → 04. Entrenamiento → 05. Exportación**

## Consideraciones antes de ejecutar

- Comprueba que el ZIP contenga las facturas XML y sus etiquetas, y que las referencias del CSV correspondan con los comprobantes del mismo paquete.
- Utiliza el mismo ZIP durante la extracción y preparación, ya que los notebooks verifican su huella para detectar cambios.
- Ten en cuenta que ejecutar nuevamente los notebooks puede sobrescribir tablas, informes, figuras y modelos anteriores.
- Si modificas los datos o el entrenamiento, vuelve a ejecutar las etapas dependientes para mantener concordancia con el modelo exportado.

El entrenamiento genera `metrics.parquet` y los informes `classification_report_train.txt`, `classification_report_validation.txt` y `classification_report_test.txt`, que permiten revisar el rendimiento del clasificador antes de utilizarlo en la aplicación.

## Exportación del modelo y motor WebAssembly

El notebook 05 genera el paquete necesario para ejecutar el clasificador en el navegador, con la siguiente estructura:

```text
ml/outputs/models/export/
├── concept_pipeline.onnx
├── manifest.json
└── runtime/
    ├── runtime.json
    └── … binario WebAssembly, cargadores y avisos de dependencias
```

El modelo ONNX incorpora operaciones personalizadas de procesamiento textual, por lo que necesita el motor WebAssembly compatible incluido en el paquete.

La carpeta temporal predeterminada para la compilación es:

```text
/tmp/invoice-onnx-runtime
```

Puedes modificarla estableciendo la variable `INVOICE_ONNX_BUILD_DIR` antes de iniciar Jupyter. Si ocurre un error, los detalles se registran en `runtime-build.log` dentro de esa carpeta.

## Uso del modelo en la aplicación

Una vez generado el paquete ONNX completo, consulta la [guía de la aplicación](../app/README.md) para instalar sus dependencias, configurar el entorno y ejecutarla.

Si ya dispones de un modelo exportado y de su motor compatible, **no es necesario volver a ejecutar los notebooks** para utilizar la aplicación web.

[Volver al README principal](../README.md)

use std::io::{Cursor, Read};

#[derive(Debug, serde::Serialize)]
pub struct DocumentContext {
    pub text: String,
    pub vocabulary: Vec<String>,
    pub kind: String,
    pub extraction_method: String,
    pub ocr_used: bool,
    pub warning: Option<String>,
    pub model_used: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Per-page text, only populated for PDFs extracted locally (not via
    /// whole-document Gemini OCR, and never for PPTX). Used to generate a
    /// teleprompter script per slide in presentation mode.
    pub pages: Option<Vec<String>>,
}

pub fn extract_text(
    file_name: &str,
    bytes: &[u8],
) -> Result<(String, String, Option<Vec<String>>), String> {
    let extension = file_name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (text, kind, pages) = match extension.as_str() {
        "pdf" => {
            let pages = extract_pdf(bytes)?;
            let text = pages.join(" ");
            (text, "PDF".to_string(), Some(pages))
        }
        "pptx" => extract_pptx(bytes).map(|text| (text, "PPTX".to_string(), None))?,
        _ => return Err("Solo se admiten archivos PDF y PPTX".into()),
    };
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let pages = pages.map(|pages| {
        pages
            .into_iter()
            .map(|page| page.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect()
    });
    Ok((text, kind, pages))
}

#[allow(clippy::too_many_arguments)]
pub fn context_from_text(
    text: String,
    kind: String,
    extraction_method: &str,
    ocr_used: bool,
    warning: Option<String>,
    model_used: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    pages: Option<Vec<String>>,
) -> Result<DocumentContext, String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err("El documento seleccionado no contiene texto legible".into());
    }
    Ok(DocumentContext {
        vocabulary: vocabulary(&text),
        text,
        kind,
        extraction_method: extraction_method.to_string(),
        ocr_used,
        warning,
        model_used,
        input_tokens,
        output_tokens,
        pages,
    })
}

pub fn needs_pdf_ocr(file_name: &str, text: &str) -> bool {
    file_name.to_ascii_lowercase().ends_with(".pdf")
        && text
            .chars()
            .filter(|character| character.is_alphanumeric())
            .count()
            < 200
}

fn extract_pdf(bytes: &[u8]) -> Result<Vec<String>, String> {
    let document = lopdf::Document::load_mem(bytes)
        .map_err(|error| format!("No se pudo leer el PDF: {error}"))?;
    let pages = document.get_pages().keys().copied().collect::<Vec<_>>();
    pages
        .into_iter()
        .map(|page| {
            document
                .extract_text(&[page])
                .map_err(|error| format!("No se pudo extraer el texto del PDF: {error}"))
        })
        .collect()
}

fn extract_pptx(bytes: &[u8]) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("No se pudo leer el PPTX: {error}"))?;
    let mut slide_names = (1..=archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|file| file.name().to_string())
        })
        .filter(|name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
        .collect::<Vec<_>>();
    slide_names.sort_by_key(|name| {
        name.rsplit('/')
            .next()
            .and_then(|file| file.strip_prefix("slide"))
            .and_then(|file| file.strip_suffix(".xml"))
            .and_then(|number| number.parse::<usize>().ok())
            .unwrap_or(usize::MAX)
    });
    let mut output = String::new();
    for name in slide_names {
        let mut file = archive.by_name(&name).map_err(|error| error.to_string())?;
        let mut xml = String::new();
        file.read_to_string(&mut xml)
            .map_err(|error| format!("No se pudo leer el contenido de la diapositiva: {error}"))?;
        output.push_str(&extract_xml_text(&xml, "slide XML")?);
        output.push('\n');
    }
    let mut note_names = (1..=archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|file| file.name().to_string())
        })
        .filter(|name| name.starts_with("ppt/notesSlides/notesSlide") && name.ends_with(".xml"))
        .collect::<Vec<_>>();
    note_names.sort_by_key(|name| {
        name.rsplit('/')
            .next()
            .and_then(|file| file.strip_prefix("notesSlide"))
            .and_then(|file| file.strip_suffix(".xml"))
            .and_then(|number| number.parse::<usize>().ok())
            .unwrap_or(usize::MAX)
    });
    for name in note_names {
        let mut file = archive.by_name(&name).map_err(|error| error.to_string())?;
        let mut xml = String::new();
        file.read_to_string(&mut xml)
            .map_err(|error| format!("No se pudieron leer las notas de la diapositiva: {error}"))?;
        let notes = extract_xml_text(&xml, "notes XML")?;
        if !notes.trim().is_empty() {
            output.push_str(" Speaker notes: ");
            output.push_str(&notes);
            output.push('\n');
        }
    }
    Ok(output)
}

fn extract_xml_text(xml: &str, source: &str) -> Result<String, String> {
    let mut output = String::new();
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(quick_xml::events::Event::Text(text)) => {
                let decoded = text.decode().map_err(|error| error.to_string())?;
                output.push_str(
                    &quick_xml::escape::unescape(&decoded)
                        .map_err(|error| format!("Could not decode {source}: {error}"))?,
                );
                output.push(' ');
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(format!("Could not parse {source}: {error}")),
        }
        buffer.clear();
    }
    Ok(output)
}

fn vocabulary(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for token in text.split(|character: char| {
        !character.is_alphanumeric() && character != '-' && character != '_'
    }) {
        if token.len() < 2
            || terms
                .iter()
                .any(|term: &String| term.eq_ignore_ascii_case(token))
        {
            continue;
        }
        let technical = token.chars().any(|character| character.is_uppercase())
            || token.chars().any(|character| character.is_ascii_digit())
            || token.contains('-')
            || token.contains('_');
        if technical {
            terms.push(token.to_string());
        }
        if terms.len() == 100 {
            break;
        }
    }
    terms
}

#[cfg(test)]
mod tests {
    use super::{needs_pdf_ocr, vocabulary};

    #[test]
    fn extracts_technical_terms() {
        let terms = vocabulary("Kubernetes PostgreSQL api v2 OpenTelemetry");
        assert!(terms.iter().any(|term| term == "Kubernetes"));
        assert!(terms.iter().any(|term| term == "v2"));
    }

    #[test]
    fn requests_ocr_only_for_sparse_pdfs() {
        assert!(needs_pdf_ocr("scan.pdf", ""));
        assert!(needs_pdf_ocr("scan.PDF", "Short scanned title"));
        assert!(!needs_pdf_ocr("slides.pptx", ""));
        assert!(!needs_pdf_ocr("digital.pdf", &"readable text ".repeat(30)));
    }
}

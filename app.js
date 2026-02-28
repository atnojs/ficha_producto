(() => {
  const { useState, useMemo, useCallback } = React;

  // ========= INYECCIONES OBLIGATORIAS =========
  function composePrePrompt(userPrompt, ctx = {}) {
    const PRE = [
      "Photorealistic rendering with premium catalog quality.",
      "Soft diffused daylight, balanced exposure, neutral-warm white balance.",
      "Filmic soft S-curve: rich blacks, smooth highlight roll-off, gentle midtone contrast.",
      "Perceived gamma around 1.03; micro-sharpening only, no halos.",
      "Cinematic depth of field with natural bokeh.",
      "No text, no extra objects, no watermarks.",
      "If a base image is provided, strictly preserve existing logos and brand marks.",
      "Camera reference: Phase One IQ4 150MP."
    ].join(" ");
    const INTEGRATION = ctx.integration === true
      ? "Photorealistic compositing of provided assets: use scenario as background plate; synthesize the model with coherent pose and skin tones; transfer garment onto the model with physically plausible cloth drape and occlusions; attach accessory with correct scale, reflections and contact shadows; match lighting and color temperature to the scenario; unify grade with the filmic profile."
      : "";
    return [PRE, INTEGRATION, userPrompt || ""].map(s => String(s||"").trim()).filter(Boolean).join(" ");
  }

  async function postProcessDataURL(dataURL, opts = {}) {
    const cfg = Object.assign({
      gamma: 1.012,
      sCurve: 0.19,
      sat: 1.01,
      warmHi: 0.10,
      unsharpAmt: 0.18,
      unsharpRadius: 1.3
    }, opts);

    const img = await new Promise((res, rej) => {
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => res(im); im.onerror = rej; im.src = dataURL;
    });
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h);

    const id = x.getImageData(0, 0, w, h), d = id.data;
    const pow = (v,g)=>Math.pow(Math.max(0,Math.min(1,v)),1/g);
    const sCurve = (v,k)=>{ const X=v-0.5; return Math.max(0,Math.min(1,0.5+(X*(1+k))/(1+k*Math.abs(X)*2))); };
    const clamp = v => v<0?0:v>255?255:v;

    for (let i=0;i<d.length;i+=4){
      let r=d[i]/255,g=d[i+1]/255,b=d[i+2]/255;
      const Y = 0.2627*r + 0.678*g + 0.0593*b;
      r=sCurve(pow(r,cfg.gamma),cfg.sCurve);
      g=sCurve(pow(g,cfg.gamma),cfg.sCurve);
      b=sCurve(pow(b,cfg.gamma),cfg.sCurve);
      const mean=(r+g+b)/3; const k=cfg.sat-1;
      r=mean+(r-mean)*(1+k); g=mean+(g-mean)*(1+k); b=mean+(b-mean)*(1+k);
      if (Y>0.6){ const wamt=cfg.warmHi*(Y-0.6)/0.4; r+=0.8*wamt; b-=0.8*wamt; }
      d[i]=clamp(r*255); d[i+1]=clamp(g*255); d[i+2]=clamp(b*255);
    }
    x.putImageData(id,0,0);

    if (cfg.unsharpAmt>0){
      const bc=document.createElement('canvas'); bc.width=w; bc.height=h;
      const bx=bc.getContext('2d'); bx.filter=`blur(${cfg.unsharpRadius}px)`; bx.drawImage(c,0,0);
      const src=x.getImageData(0,0,w,h), blr=bx.getImageData(0,0,w,h);
      const sd=src.data, bd=blr.data;
      for (let i=0;i<sd.length;i+=4){
        sd[i]   = clamp(sd[i]   + (sd[i]   - bd[i])   * cfg.unsharpAmt);
        sd[i+1] = clamp(sd[i+1] + (sd[i+1] - bd[i+1]) * cfg.unsharpAmt);
        sd[i+2] = clamp(sd[i+2] + (sd[i+2] - bd[i+2]) * cfg.unsharpAmt);
      }
      x.putImageData(src,0,0);
    }
    return c.toDataURL('image/jpeg', 0.95);
  }

  // ======= Helpers de integración y config =======
  const baseImageCfg = {
    gradingPreset: "filmic-soft",
    contrastProfile: "soft S-curve, rich blacks, smooth highlight roll-off",
    perceivedGamma: 1.03,
    whiteBalance: "daylight neutral-warm",
    subjectSaturationBoost: "slight",
    backgroundSaturation: "neutral",
    sharpening: "micro only, no halos"
  };

  function __buildImageConfigFromPrompt(finalPrompt) {
    const txt = (finalPrompt || "").toLowerCase();
    const isWarmIndoor = /(interior|pub|bar|tungsten|lámpara|lamp|sconce)/.test(txt);
    const imageCfg99 = Object.assign({}, baseImageCfg, isWarmIndoor ? {
      whiteBalance: "tungsten-warm",
      backgroundSaturation: "slightly reduced"
    } : {});
    Object.assign(imageCfg99, { toneMap: "filmic-soft-warm" });
    return imageCfg99;
  }

  function __extendPayloadWithConfigs(payload, finalPrompt) {
    payload.generationConfig = Object.assign(
      { responseModalities: ["IMAGE"], temperature: 0.5 },
      payload.generationConfig || {}
    );
    const imageCfg = __buildImageConfigFromPrompt(finalPrompt);
    payload.imageConfig = Object.assign(imageCfg, payload.imageConfig || {});
  }

  function __detectIntegrationFromImage(imageInline) {
    try {
      if (!imageInline) return false;
      let partsLen = 0;
      if (Array.isArray(imageInline)) partsLen = imageInline.length;
      else if (Array.isArray(imageInline?.parts)) partsLen = imageInline.parts.length;
      return partsLen === 4;
    } catch { return false; }
  }

  function __normalizeImageForApi(imageInline) {
    // Intenta reordenar a [scenario, model, clothing, accessory] si vienen etiquetados
    try {
      if (!imageInline) return imageInline;
      if (Array.isArray(imageInline) && imageInline.length === 4) return imageInline;
      if (imageInline && typeof imageInline === 'object') {
        const keys = ["scenario","model","clothing","accessory"];
        if (keys.every(k => k in imageInline)) {
          return [imageInline.scenario, imageInline.model, imageInline.clothing, imageInline.accessory];
        }
      }
      return imageInline;
    } catch { return imageInline; }
  }

  // ========= Utils =========
  const fileToBase64Part = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.readAsDataURL(file);
      r.onload = () => {
        const base64 = String(r.result).split(",")[1];
        resolve({ data: base64, mimeType: file.type });
      };
      r.onerror = reject;
    });

  const base64ToBlob = (base64, mimeType) => {
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mimeType });
    } catch {
      return null;
    }
  };

  const dataURLToBlob = (dataURL) => {
    const [hdr, b64] = String(dataURL).split(',');
    const mime = (/^data:([^;]+);base64/.exec(hdr)||[])[1] || 'image/jpeg';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  };

  // Normaliza imágenes para el iframe: acepta {data, mimeType} con o sin prefijo data:
  const toDataUrl = (img) => {
    const mime = (img.mimeType || "image/png").trim();
    const d = String(img.data || "").trim();
    if (d.startsWith("data:")) return d;
    return `data:${mime};base64,${d}`;
  };

  // ========= Helpers de postprocesado para previews =========
  async function __ensureProcessedPreview(obj) {
    const mime = obj.image?.mimeType || "image/png";
    const data = obj.image?.data || "";
    const srcRaw = data.startsWith("data:") ? data : `data:${mime};base64,${data}`;
    obj.previewSrc = await postProcessDataURL(srcRaw);
    if (Array.isArray(obj.history)) {
      obj.historyPreviewSrcs = [];
      for (const h of obj.history) {
        const hm = h?.mimeType || "image/png";
        const hd = h?.data || "";
        const hRaw = hd.startsWith("data:") ? hd : `data:${hm};base64,${hd}`;
        obj.historyPreviewSrcs.push(await postProcessDataURL(hRaw));
      }
    } else {
      obj.historyPreviewSrcs = [obj.previewSrc];
    }
  }
  async function __ensureProcessedPreviews(arr) {
    for (const o of arr) await __ensureProcessedPreview(o);
  }

  // ========= API proxy.php =========
  const api = {
    async describe(imageInline, referenceDesc) {
      let prompt =
        "Escribe una descripción de producto para e-commerce, en español, basada en la imagen. La descripción debe ser atractiva y concisa (máx 1000 caracteres). Responde únicamente con la descripción del producto, sin añadir texto introductorio.";
      if (referenceDesc && referenceDesc.trim() !== "") {
        prompt += `\n\nUtiliza la siguiente descripción como inspiración y referencia para mejorar el resultado: "${referenceDesc}"`;
      }

      const __imageNorm = __normalizeImageForApi(imageInline);
      const finalPrompt = composePrePrompt(prompt, { integration: __detectIntegrationFromImage(__imageNorm) });
      const __payload = { task: "describe", image: __imageNorm, prompt: finalPrompt };
      __extendPayloadWithConfigs(__payload, finalPrompt);
      const res = await fetch("./proxy.php", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(__payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error describiendo");
      return data.description;
    },

    async generateImages(imageInline, onProgress) {
      const prompts = [
        "A photorealistic studio product photo of a [PRODUCT]. Captured with a Phase One IQ4 150MP medium format camera using a 90mm lens, aperture f/4 for crisp focus and shallow depth of field. The product is centered on a clean, bright, minimalist background with soft diffused lighting from both sides. Highlight material textures and edges naturally, no harsh reflections, no text, no watermark, no extra objects. Professional catalog composition, high-end advertising aesthetic, balanced exposure, subtle contrast, and refined color accuracy. **IMPORTANT: Preserve any existing logos, brand marks, text, or branding elements exactly as they appear in the original image. Do not modify, remove, or alter any logos or branding.**",
        
        "A photorealistic lifestyle photo featuring a [PRODUCT] in a realistic everyday urban environment—such as a café table, street bench, local shop, or outdoor market. Captured with a Phase One IQ4 150MP, 80mm lens, aperture f/2.8 for natural bokeh and soft depth of field. Natural daylight with gentle fill light, warm tone balance, realistic textures, and authentic atmosphere. Include subtle human presence or context elements that show real use or display of the product. No text, no artificial lighting artifacts, no watermark. Professional-grade realism and composition suitable for premium social media advertising. **IMPORTANT: Preserve any existing logos, brand marks, text, or branding elements exactly as they appear in the original image. Do not modify, remove, or alter any logos or branding.**",
        
        "A photorealistic lifestyle photo of a [PRODUCT] displayed or being used naturally inside a public indoor space—such as a café, boutique, art studio, or concept store. Captured with a Phase One IQ4 150MP medium format camera, 80mm lens at f/2.8 for shallow depth of field and cinematic focus. Soft directional lighting through large windows or diffused studio lights, highlighting textures and realistic reflections. Professional interior ambiance with warm tones, subtle shadows, and balanced exposure. Include authentic human presence or contextual elements (tables, shelves, decor) that enhance realism without distraction. No text, no logo, no watermark, no artificial look. High-end advertising composition optimized for premium lifestyle campaigns and social media visuals. **IMPORTANT: Preserve any existing logos, brand marks, text, or branding elements exactly as they appear in the original image. Do not modify, remove, or alter any logos or branding.**",
        
        "A photorealistic close-up of a [PRODUCT], highlighting its texture, materials, and key design features. Captured with a Phase One IQ4 150MP medium format camera using a 120mm macro lens at f/2.8 for shallow depth of field. Focus precisely on the most distinctive area of the product, keeping the rest softly blurred to emphasize depth and realism. Controlled studio lighting with soft diffused highlights to reveal surface detail and material quality. Maintain perfect framing within the original composition—no cropping or elements extending beyond frame limits. No text, no watermark, no artificial reflections. Professional macro-style image optimized for high-end product advertising and social media presentation. **IMPORTANT: Preserve any existing logos, brand marks, text, or branding elements exactly as they appear in the original image. Do not modify, remove, or alter any logos or branding.**",
        
        "A photorealistic studio image of a [PRODUCT] placed on a modern geometric pedestal or platform, as if displayed in a contemporary art museum. Captured with a Phase One IQ4 150MP medium format camera, 90mm lens, aperture f/5.6 for full sharpness and balanced depth of field. Use a solid-color background that complements the product's tones—neutral, soft, or slightly gradient—to create an elegant, sophisticated atmosphere. Lighting should be diffused yet directional, emphasizing clean lines, subtle reflections, and a premium exhibition look. The product must appear as a collector's piece, central and perfectly composed, with no clutter or additional props. No text, no watermark, no overexposed highlights. High-end composition suitable for luxury advertising and fine art presentation. **IMPORTANT: Preserve any existing logos, brand marks, text, or branding elements exactly as they appear in the original image. Do not modify, remove, or alter any logos or branding.**",
      ];
      
      const images = [];
      const failedPrompts = [];
      
      for (let i = 0; i < prompts.length; i++) {
        if (onProgress) onProgress(`Generando imagen ${i + 1} de ${prompts.length}.`);
        try {
          const finalPrompt = composePrePrompt(prompts[i], { integration: __detectIntegrationFromImage(__normalizeImageForApi(imageInline)) });
          const __imageNorm = __normalizeImageForApi(imageInline);
          const __payload = { task: "generateImages", image: __imageNorm, prompts: [finalPrompt] };
          __extendPayloadWithConfigs(__payload, finalPrompt);
          const res = await fetch("./proxy.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(__payload),
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || `Error generando imagen ${i + 1}`);
          }
          if (data.images && data.images.length > 0) {
            images.push(data.images[0]);
          } else {
            failedPrompts.push(i + 1);
          }
        } catch (error) {
          console.error(`Error generando imagen ${i + 1}:`, error);
          failedPrompts.push(i + 1);
        }
      }
      
      if (images.length === 0) {
        throw new Error("No se pudo generar ninguna imagen. Por favor, inténtalo de nuevo con otra imagen.");
      }
      
      if (failedPrompts.length > 0) {
        console.warn(`No se pudieron generar las imágenes: ${failedPrompts.join(", ")}`);
      }
      
      return images;
    },

    async editImage(currentImage, customPrompt) {
      const logoPreservationInstructions = " **CRITICAL: Preserve any existing logos, brand marks, text, or branding elements exactly as they appear in the original image. Do not modify, remove, alter, or obscure any logos or branding under any circumstances. The logo/branding must remain perfectly visible and unchanged.**";
      const enhancedPrompt = customPrompt + logoPreservationInstructions;

      const finalPrompt = composePrePrompt(enhancedPrompt, { integration: __detectIntegrationFromImage(__normalizeImageForApi(currentImage)) });
      const __payload = {
        task: "generateImages",
        image: __normalizeImageForApi(currentImage),
        prompts: [finalPrompt],
      };
      __extendPayloadWithConfigs(__payload, finalPrompt);
      
      const res = await fetch("./proxy.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(__payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error editando imagen");
      if (data.images && data.images.length > 0) {
        return data.images[0];
      } else {
        throw new Error("La API no devolvió una imagen editada.");
      }
    },
    
    async improvePrompt(userPrompt) {
      let improvedPrompt = userPrompt;
      if (!improvedPrompt.includes("fotográfica") && !improvedPrompt.includes("foto")) {
        improvedPrompt = "Imagen fotográfica " + improvedPrompt;
      }
      if (!improvedPrompt.includes("calidad") && !improvedPrompt.includes("alta")) {
        improvedPrompt += ", alta calidad";
      }
      if (!improvedPrompt.includes("luz") && !improvedPrompt.includes("iluminación")) {
        improvedPrompt += ", iluminación profesional";
      }
      if (!improvedPrompt.includes("detallado") && !improvedPrompt.includes("detalles")) {
        improvedPrompt += ", muy detallado";
      }
      if (!improvedPrompt.includes("realista") && !improvedPrompt.includes("estilo")) {
        improvedPrompt += ", estilo realista";
      }
      if (!improvedPrompt.includes("cámara") && !improvedPrompt.includes("lente")) {
        improvedPrompt += ", capturado con cámara profesional";
      }
      if (improvedPrompt.includes("cambia") || improvedPrompt.includes("cambiar")) {
        improvedPrompt = improvedPrompt.replace(/cambia|cambiar/g, "modifica");
      }
      if (improvedPrompt.includes("fondo")) {
        improvedPrompt += ", fondo bien definido";
      }
      if (!improvedPrompt.includes("producto") && !improvedPrompt.includes("objeto")) {
        improvedPrompt += ", producto como elemento principal";
      }
      if (!improvedPrompt.includes("logo") && !improvedPrompt.includes("marca") && !improvedPrompt.includes("branding")) {
        improvedPrompt += ". **MUY IMPORTANTE: Preservar todos los logos, marcas, texto o elementos de branding exactamente como aparecen en la imagen original. No modificar, eliminar ni alterar ningún logo o branding bajo ninguna circunstancia.**";
      }
      improvedPrompt = improvedPrompt
        .replace(/\s+/g, ' ')
        .replace(/,\s*,/g, ',')
        .trim();
      if (!improvedPrompt.endsWith('.') && !improvedPrompt.endsWith(',')) {
        improvedPrompt += '.';
      }
      improvedPrompt = improvedPrompt.charAt(0).toUpperCase() + improvedPrompt.slice(1);
      return improvedPrompt;
    }
  };

  // ========= Plantilla HTML para ZIP =========
  const sharedHtmlStyle = `
@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@800&family=Dancing+Script:wght@700&display=swap');

body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;margin:0;background:#fff;color:#212529}
.container{max-width:960px;margin:2rem auto;padding:0 1rem;}
.product-grid{display:grid;grid-template-columns:1fr;gap:2rem}
@media(min-width:768px){.product-grid{grid-template-columns:1fr 1fr}}
.gallery{display:flex;flex-direction:column}
.main-image-container{margin-bottom:1rem;border:1px solid #dee2e6;border-radius:4px;overflow:hidden}
.main-image{width:100%;display:block;aspect-ratio:1/1;object-fit:cover}
.thumbnail-container{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem}
.thumbnail{width:100%;cursor:pointer;border:2px solid transparent;border-radius:4px;transition:border-color .2s;aspect-ratio:1/1;object-fit:cover}
.thumbnail.active,.thumbnail:hover{border-color:#0d6efd}
.product-info{display:flex;flex-direction:column}

/* Título con Brush Script MT y múltiples fallbacks */
.product-title-modern{
  font-family:'Brush Script MT', cursive;
  font-size:3.5rem;
  font-weight:700;
  margin:0 0 1.5rem;
  line-height:1.1;
  position:relative;
  display:inline-block;
  text-align:center;
  width:100%;
  color:#667eea;
  text-shadow:0 2px 10px rgba(102, 126, 234, 0.2);
  letter-spacing:0.02em;
  transform:rotate(-2deg);
  transition:transform 0.3s ease;
}

/* Fallback para Dancing Script (Google Fonts) si Brush Script MT no está disponible */
@font-face {
  font-family: 'Brush Script MT Fallback';
  src: local('Dancing Script'), local('Dancing Script Bold');
  font-weight: 700;
  font-style: normal;
}

/* Aplicar fallback si Brush Script MT no carga */
.product-title-modern:not(:has(.brush-script-loaded)) {
  font-family: 'Dancing Script', 'Brush Script MT Fallback', cursive;
}

/* Gradiente para navegadores que soportan background-clip */
@supports (-webkit-background-clip: text) or (background-clip: text){
  .product-title-modern{
    background:linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
    -webkit-background-clip:text;
    background-clip:text;
    -webkit-text-fill-color:transparent;
    text-fill-color:transparent;
    color:transparent;
    text-shadow:none;
  }
}

/* Línea decorativa animada */
.product-title-modern::after{
  content:'';
  position:absolute;
  bottom:-8px;
  left:50%;
  transform:translateX(-50%);
  width:80%;
  height:4px;
  background:linear-gradient(90deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
  border-radius:2px;
  animation:shimmer 3s ease-in-out infinite;
}

@keyframes shimmer{
  0%,100%{opacity:0.7;transform:translateX(-50%) scaleX(0.8);}
  50%{opacity:1;transform:translateX(-50%) scaleX(1);}
}

/* Efecto hover */
.product-title-modern:hover{
  transform:rotate(-2deg) translateY(-3px);
  transition:transform 0.3s ease;
}

/* Variante elegante sin gradiente (fallback) */
@supports not (-webkit-background-clip: text) or not (background-clip: text){
  .product-title-modern{
    background:linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip:text;
    background-clip:text;
    -webkit-text-fill-color:transparent;
    text-fill-color:transparent;
    color:#667eea;
    position:relative;
  }
  
  .product-title-modern::before{
    content:attr(data-text);
    position:absolute;
    top:0;
    left:0;
    width:100%;
    height:100%;
    background:linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
    -webkit-background-clip:text;
    background-clip:text;
    -webkit-text-fill-color:transparent;
    text-fill-color:transparent;
    z-index:1;
  }
}

.product-price{font-size:1.5rem;color:#198754;margin-bottom:1.5rem;font-weight:600}
.product-description{line-height:1.6}
h2{border-bottom:1px solid #dee2e6;padding-bottom:.5rem;margin-top:2rem;font-size:1.25rem;font-weight:600}

/* Responsive */
@media(max-width:768px){
  .product-title-modern{font-size:3rem;}
}
@media(max-width:480px){
  .product-title-modern{font-size:2.5rem;}
}
`;


  const createBaseHtml = (data, imageSources) => `
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${data.name}</title>
<style>${sharedHtmlStyle}</style>
</head>
<body>
  <div class="container">
    <div class="product-grid">
      <div class="gallery">
        <div class="main-image-container">
          <img id="mainImage" src="${imageSources[0]}" alt="Imagen principal de ${data.name}" class="main-image">
        </div>
        <div class="thumbnail-container">
          ${imageSources
            .map(
              (src, i) =>
                `<img src="${src}" alt="Miniatura ${i + 1}" class="thumbnail ${
                  i === 0 ? "active" : ""
                }" onclick="changeImage(this)">`
            )
            .join("")}
        </div>
      </div>
      <div class="product-info">
        <h1 class="product-title-modern" data-text="${data.name}">${data.name}</h1>
        <p class="product-price">${data.price} €</p>
        <h2>Descripción</h2>
        <p class="product-description">${data.description.replace(/\n/g, "<br>")}</p>
      </div>
    </div>
  </div>
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      const title = document.querySelector('.product-title-modern');
      const computedFont = window.getComputedStyle(title).fontFamily;
      if (computedFont.includes('Brush Script MT')) {
        title.classList.add('brush-script-loaded');
      }
    });
    function changeImage(clickedThumbnail){
      document.getElementById('mainImage').src = clickedThumbnail.src;
      document.querySelectorAll('.thumbnail').forEach(t=>t.classList.remove('active'));
      clickedThumbnail.classList.add('active');
    }
  <\/script>
</body>
</html>`;

  // Para el .ZIP: rutas relativas a /images
  const createProductPageHtml = (data) => {
    const imageFiles = data.generatedImages.map((imgObj, i) => {
      return `images/producto-${i + 1}.jpg`;
    });
    return `<!DOCTYPE html>${createBaseHtml(data, imageFiles)}`;
  };

  // ZIP con imágenes postprocesadas obligatorias
  const createZip = async (productData) => {
    const zip = new JSZip();
    zip.file("index.html", createProductPageHtml(productData));
    const folder = zip.folder("images");
    for (let i = 0; i < productData.generatedImages.length; i++) {
      const imgObj = productData.generatedImages[i];
      const mime = imgObj.image?.mimeType || "image/png";
      const data = imgObj.image?.data || "";
      const srcRaw = data.startsWith("data:") ? data : `data:${mime};base64,${data}`;
      const processed = await postProcessDataURL(srcRaw);
      const blob = dataURLToBlob(processed);
      if (blob) folder.file(`producto-${i + 1}.jpg`, blob);
    }
    return zip.generateAsync({ type: "blob" });
  };

  // ========= UI =========
  const HeaderIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-indigo-400" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21.384,10.428A1.99,1.99,0,0,0,22,8.5,2,2,0,0,0,20,6.5H16.5V2H7.5V6.5H4a2,2,0,0,0-2,2,1.99,1.99,0,0,0,.616,1.928A2.012,2.012,0,0,0,2,12.5v7a2,2,0,0,0,2,2H20a2,2,0,0,0,2-2v-7a2.012,2.012,0,0,0-.616-2.072ZM8.5,3h7V6.5h-7ZM20,19.5H4v-7h16Z" />
      <path d="M12,14.5a2,2,0,1,0,2,2A2,2,0,0,0,12,14.5Z" />
    </svg>
  );

  const Loader = ({ message }) => (
    <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex flex-col items-center justify-center z-50">
      <div className="loader-spinner"></div>
      <p className="text-white text-lg mt-4">{message}</p>
    </div>
  );

  const ZoomModal = ({ src, onClose }) => {
    if (!src) return null;
    return (
      <div 
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black bg-opacity-95 cursor-zoom-out"
        onClick={onClose}
      >
        <div className="relative w-full h-full flex items-center justify-center p-4">
          <img 
            src={src} 
            className="max-w-full max-h-full object-contain shadow-2xl rounded-sm"
            alt="Zoomed product"
          />
          <button 
            className="absolute top-4 right-4 text-white hover:text-gray-300 focus:outline-none bg-black bg-opacity-50 rounded-full p-2"
            onClick={onClose}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  const ProductForm = ({ onGenerate, disabled }) => {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [referenceDesc, setReferenceDesc] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [error, setError] = useState("");
  const [preserveLogo, setPreserveLogo] = useState(true);

  const handleImageChange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) {
      setError("La imagen es demasiado grande. Máximo 4MB.");
      return;
    }
    setError("");
    setImageFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name || !price || !imageFile) {
      setError("Todos los campos son obligatorios.");
      return;
    }
    setError("");
    onGenerate(name, price, imageFile, referenceDesc, preserveLogo);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-gray-300">Nombre del Producto</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="mt-1 block w-full bg-gray-700 border border-gray-600 rounded-md shadow-sm py-2 px-3 text-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300">Precio (€)</label>
        <input
          type="number"
          step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          required
          className="mt-1 block w-full bg-gray-700 border border-gray-600 rounded-md shadow-sm py-2 px-3 text-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300">Descripción de Referencia (Opcional)</label>
        <textarea
          value={referenceDesc}
          onChange={(e) => setReferenceDesc(e.target.value)}
          rows="3"
          className="mt-1 block w-full bg-gray-700 border border-gray-600 rounded-md shadow-sm py-2 px-3 text-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
          placeholder="Ej: Zapatillas de running ligeras, con buena amortiguación."
        ></textarea>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300">Imagen Casera del Producto</label>
        <div className="mt-2 flex justify-center rounded-md border-2 border-dashed border-gray-600 px-6 pt-5 pb-6">
          <div className="space-y-1 text-center">
            {previewUrl ? (
              <img src={previewUrl} alt="Previsualización" className="mx-auto h-24 w-24 rounded-md object-cover" />
            ) : (
              <svg
                className="mx-auto h-12 w-12 text-gray-500"
                stroke="currentColor"
                fill="none"
                viewBox="0 0 48 48"
                aria-hidden="true"
              >
                <path
                  d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            <div className="flex text-sm text-gray-400 justify-center">
              <label htmlFor="product-image" className="relative cursor-pointer rounded-md font-medium text-indigo-400 hover:text-indigo-300">
                <span>Sube un archivo</span>
                <input
                  id="product-image"
                  name="product-image"
                  type="file"
                  className="sr-only"
                  accept="image/png, image/jpeg, image/webp"
                  onChange={handleImageChange}
                  required
                />
              </label>
              <p className="pl-1">o arrástralo aquí</p>
            </div>
            <p className="text-xs text-gray-500">PNG, JPG, WEBP hasta 4MB</p>
          </div>
        </div>
      </div>

      <div className="flex items-center">
        <input
          id="preserve-logo"
          name="preserve-logo"
          type="checkbox"
          checked={preserveLogo}
          onChange={(e) => setPreserveLogo(e.target.checked)}
          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
        />
        <label htmlFor="preserve-logo" className="ml-2 block text-sm text-gray-300">
          <span className="font-semibold">Preservar logos y branding</span> - Mantener todos los logos, marcas y texto exactamente como aparecen en la imagen original
        </label>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button
        type="submit"
        disabled={disabled}
        className="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-indigo-500 disabled:bg-gray-500 disabled:cursor-not-allowed"
      >
        Generar Ficha de Producto
      </button>
    </form>
  );
};

  const EditImageModal = ({ isOpen, onClose, onEdit, onImprovePrompt, isLoading }) => {
    const [prompt, setPrompt] = useState("");
    const [error, setError] = useState("");
    const [isImproving, setIsImproving] = useState(false);

    const handleSubmit = (e) => {
      e.preventDefault();
      if (!prompt.trim()) {
        setError("Por favor, introduce un prompt para editar la imagen.");
        return;
      }
      setError("");
      onEdit(prompt);
    };

    const handleImprovePrompt = async () => {
      if (!prompt.trim()) {
        setError("Por favor, introduce un prompt antes de mejorarlo.");
        return;
      }
      setError("");
      setIsImproving(true);
      try {
        const improvedPrompt = await onImprovePrompt(prompt);
        setPrompt(improvedPrompt);
      } catch (e) {
        console.error("Error mejorando prompt:", e);
        setError("No se pudo mejorar el prompt. Por favor, inténtalo de nuevo.");
      } finally {
        setIsImproving(false);
      }
    };

    if (!isOpen) return null;

    return (
      <div className="modal-overlay">
        <div className="modal-container">
          <h3 className="modal-title">Editar Imagen</h3>
          <form onSubmit={handleSubmit}>
            <div className="modal-field">
              <label className="modal-label">
                Describe cómo quieres editar la imagen
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows="4"
                className="modal-textarea"
                placeholder="Ej: Cambia el fondo a un color azul brillante, haz que el producto parezca más brillante..."
              ></textarea>
            </div>
            {error && <p className="modal-error">{error}</p>}
            <div className="modal-buttons">
              <button
                type="button"
                onClick={handleImprovePrompt}
                disabled={isImproving || !prompt.trim()}
                className="modal-button modal-button-improve"
              >
                {isImproving ? "✨ Mejorando..." : "✨ Mejorar con IA"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="modal-button modal-button-cancel"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={isLoading}
                className="modal-button modal-button-submit"
              >
                {isLoading ? "Editando..." : "Editar Imagen"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  };

  // Vista previa que usa imágenes postprocesadas
  const ProductPreview = ({ productData, onReset, onDeleteImage, onEditImage, onUndoImage, onCompareImage }) => {
    const [mainImageIndex, setMainImageIndex] = useState(0);
    const [isComparing, setIsComparing] = useState(false);
    const [compareIndex, setCompareIndex] = useState(0);
    const [zoomedImage, setZoomedImage] = useState(null);
    
    const getCurrentImage = () => {
      if (isComparing) {
        return productData.generatedImages[mainImageIndex].historyPreviewSrcs?.[compareIndex] || productData.generatedImages[mainImageIndex].previewSrc;
      }
      return productData.generatedImages[mainImageIndex].previewSrc;
    };
    
    const imageUrls = productData.generatedImages.map(imgObj => imgObj.previewSrc);
    
    const handleThumbnailClick = (index) => {
      setMainImageIndex(index);
      setIsComparing(false);
    };

    const handleDeleteImage = () => {
      onDeleteImage(mainImageIndex);
      if (mainImageIndex > 0 && mainImageIndex >= productData.generatedImages.length - 1) {
        setMainImageIndex(mainImageIndex - 1);
      }
      setIsComparing(false);
    };

    const handleEditImage = () => {
      onEditImage(mainImageIndex);
    };

    const handleUndoImage = () => {
      onUndoImage(mainImageIndex);
      setIsComparing(false);
    };

    const handleCompareImage = () => {
      const history = productData.generatedImages[mainImageIndex].historyPreviewSrcs || [];
      if (history.length > 1) {
        if (isComparing) {
          setCompareIndex((prev) => (prev > 0 ? prev - 1 : history.length - 1));
        } else {
          setCompareIndex(history.length - 2);
          setIsComparing(true);
        }
      }
    };

    // Nueva función para descargar la imagen actual
    const handleDownloadSingle = () => {
      const link = document.createElement('a');
      link.href = getCurrentImage();
      link.download = `imagen-producto-${mainImageIndex + 1}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    const hasHistory = (productData.generatedImages[mainImageIndex]?.historyPreviewSrcs?.length || 0) > 1;
    const currentVersionLabel = isComparing 
      ? `Versión ${compareIndex + 1} de ${productData.generatedImages[mainImageIndex].historyPreviewSrcs.length}` 
      : `Versión actual`;

    return (
      <div className="bg-white text-gray-900 rounded-lg p-6">
        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="flex flex-col">
              <div className="mb-4 border border-gray-300 rounded-lg overflow-hidden relative">
                <img 
                  src={getCurrentImage()} 
                  alt={`Imagen ${mainImageIndex + 1} de ${productData.name}`}
                  className="w-full h-auto aspect-square object-cover cursor-zoom-in"
                  onClick={() => setZoomedImage(getCurrentImage())}
                  title="Haz clic para ampliar"
                />
                {hasHistory && (
                  <div className="absolute top-2 left-2 bg-black bg-opacity-60 text-white px-2 py-1 rounded text-xs">
                    {currentVersionLabel}
                  </div>
                )}
                <div className="absolute top-2 right-2 flex space-x-1">
                   {/* Botón de descarga añadido */}
                   <button
                    onClick={handleDownloadSingle}
                    className="p-1.5 bg-green-600 bg-opacity-80 text-white rounded hover:bg-opacity-100 focus:outline-none transition-all"
                    title="Descargar imagen actual"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                  {hasHistory && (
                    <>
                      <button
                        onClick={handleCompareImage}
                        className={`p-1.5 bg-purple-600 bg-opacity-80 text-white rounded hover:bg-opacity-100 focus:outline-none transition-all`}
                        title={isComparing ? "Ver versión anterior" : "Comparar con versiones anteriores"}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
                          <path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                        </svg>
                      </button>
                      <button
                        onClick={handleUndoImage}
                        className="p-1.5 bg-orange-600 bg-opacity-80 text-white rounded hover:bg-opacity-100 focus:outline-none transition-all"
                        title="Deshacer última edición"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
                          <path fillRule="evenodd" d="M7.707 3.293a1 1 0 010 1.414L5.414 7H11a7 7 0 017 7v2a1 1 0 11-2 0v-2a5 5 0 00-5-5H5.414l2.293 2.293a1 1 0 11-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      </button>
                    </>
                  )}
                  <button
                    onClick={handleEditImage}
                    className="p-1.5 bg-blue-600 bg-opacity-80 text-white rounded hover:bg-opacity-100 focus:outline-none transition-all"
                    title="Editar imagen"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                    </svg>
                  </button>
                  <button
                    onClick={handleDeleteImage}
                    className="p-1.5 bg-red-600 bg-opacity-80 text-white rounded hover:bg-opacity-100 focus:outline-none transition-all"
                    title="Eliminar imagen"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {imageUrls.map((url, index) => (
                  <img
                    key={index}
                    src={url}
                    alt={`Miniatura ${index + 1}`}
                    className={`w-full h-auto aspect-square object-cover cursor-pointer border-2 rounded ${
                      index === mainImageIndex ? 'border-blue-500' : 'border-transparent hover:border-gray-300'
                    }`}
                    onClick={() => handleThumbnailClick(index)}
                  />
                ))}
              </div>
            </div>
            
            <div className="flex flex-col">
              <div className="mb-6">
                <h1 className="product-title-brush">{productData.name}</h1>
              </div>
              <p className="text-2xl text-green-600 font-semibold mb-6">{productData.price} €</p>
              <div>
                <h2 className="text-xl font-semibold border-b border-gray-300 pb-2 mb-4">Descripción</h2>
                <p className="leading-relaxed whitespace-pre-line">{productData.description}</p>
              </div>
            </div>
          </div>
        </div>
        
        {/* Modal de Zoom */}
        <ZoomModal src={zoomedImage} onClose={() => setZoomedImage(null)} />
      </div>
    );
  };

  const PreviewDisplay = ({ productData, zipBlob, onReset, onDeleteImage, onEditImage, onUndoImage, onCompareImage }) => {
    const handleDownload = () => {
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ficha-producto.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-semibold">Previsualización y Descarga</h2>
          <button
            onClick={onReset}
            className="py-2 px-4 border border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-300 bg-gray-700 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-indigo-500"
          >
            Crear Otro
          </button>
        </div>
        <div className="text-center">
          <button
            onClick={handleDownload}
            className="w-full md:w-auto inline-flex justify-center py-3 px-6 border border-transparent rounded-md shadow-sm text-base font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-green-500"
          >
            Descargar Archivo .ZIP
          </button>
        </div>
        <ProductPreview 
          productData={productData} 
          onReset={onReset} 
          onDeleteImage={onDeleteImage}
          onEditImage={onEditImage}
          onUndoImage={onUndoImage}
          onCompareImage={onCompareImage}
        />
      </div>
    );
  };

  const App = () => {
    const [isLoading, setIsLoading] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState("");
    const [error, setError] = useState(null);
    const [generatedData, setGeneratedData] = useState(null);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editingImageIndex, setEditingImageIndex] = useState(null);

    const handleGenerate = useCallback(async (name, price, imageFile, referenceDesc, preserveLogo = true) => {
  setIsLoading(true);
  setError(null);
  setGeneratedData(null);

  try {
    setLoadingMessage("Convirtiendo imagen.");
    const inline = await fileToBase64Part(imageFile);

    setLoadingMessage("Generando descripción.");
    const description = await api.describe(inline, referenceDesc);

    setLoadingMessage("Generando imágenes de producto.");
    const images = await api.generateImages(inline, setLoadingMessage);

    if (images.length === 0) {
      throw new Error("No se pudieron generar imágenes. Inténtalo de nuevo.");
    }

    // Crear estructura con historial para cada imagen
    const imagesWithHistory = images.map(img => ({ image: img, history: [img], preserveLogo: preserveLogo }));

    // Postprocesado filmic obligatorio
    setLoadingMessage("Aplicando acabado filmic.");
    await __ensureProcessedPreviews(imagesWithHistory);

    const productData = { 
      name, 
      price, 
      description, 
      generatedImages: imagesWithHistory,
      preserveLogo: preserveLogo
    };

    setLoadingMessage("Empaquetando ZIP.");
    const zipBlob = await createZip(productData);

    setGeneratedData({ 
      productData, 
      zipBlob, 
      originalImage: inline,
      preserveLogo: preserveLogo
    });
  } catch (e) {
    setError(e.message || "Error desconocido");
  } finally {
    setIsLoading(false);
  }
}, []);

    const handleReset = () => {
      setGeneratedData(null);
      setError(null);
    };

    const handleDeleteImage = useCallback((index) => {
      if (!generatedData) return;
      
      const newImages = [...generatedData.productData.generatedImages];
      newImages.splice(index, 1);
      
      if (newImages.length === 0) {
        setError("No puedes eliminar todas las imágenes. Debe quedar al menos una.");
        return;
      }
      
      const newProductData = { ...generatedData.productData, generatedImages: newImages };
      
      createZip(newProductData).then(zipBlob => {
        setGeneratedData({
          ...generatedData,
          productData: newProductData,
          zipBlob
        });
      });
    }, [generatedData]);

    const handleEditImage = useCallback((index) => {
      if (!generatedData) return;
      setEditingImageIndex(index);
      setIsEditModalOpen(true);
    }, [generatedData]);

    const handleEditSubmit = useCallback(async (prompt) => {
      if (!generatedData || editingImageIndex === null) return;
      
      setIsLoading(true);
      setLoadingMessage("Editando imagen...");
      
      try {
        const currentImage = generatedData.productData.generatedImages[editingImageIndex].image;
        const editedImage = await api.editImage(currentImage, prompt);
        
        const newImages = [...generatedData.productData.generatedImages];
        newImages[editingImageIndex] = { image: editedImage, history: [...newImages[editingImageIndex].history, editedImage] };
        await __ensureProcessedPreview(newImages[editingImageIndex]);
        
        const newProductData = { ...generatedData.productData, generatedImages: newImages };
        const zipBlob = await createZip(newProductData);
        
        setGeneratedData({
          ...generatedData,
          productData: newProductData,
          zipBlob
        });
        
        setIsEditModalOpen(false);
        setEditingImageIndex(null);
      } catch (e) {
        setError(e.message || "Error editando imagen");
      } finally {
        setIsLoading(false);
      }
    }, [generatedData, editingImageIndex]);

    const handleImprovePrompt = useCallback(async (prompt) => {
      return await api.improvePrompt(prompt);
    }, []);

    const handleUndoImage = useCallback((index) => {
      if (!generatedData) return;
      
      const newImages = [...generatedData.productData.generatedImages];
      const imageHistory = newImages[index].history;
      
      if (imageHistory.length > 1) {
        imageHistory.pop();
        newImages[index].image = imageHistory[imageHistory.length - 1];
        __ensureProcessedPreview(newImages[index]).then(() => {
          const newProductData = { ...generatedData.productData, generatedImages: newImages };
          createZip(newProductData).then(zipBlob => {
            setGeneratedData({
              ...generatedData,
              productData: newProductData,
              zipBlob
            });
          });
        });
      }
    }, [generatedData]);

    const handleCompareImage = useCallback((index) => {}, []);

    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-2xl w-full mx-auto bg-gray-800 p-8 rounded-xl shadow-2xl">
          {isLoading && <Loader message={loadingMessage} />}
          <header className="text-center mb-8">
            <div className="flex justify-center items-center gap-4">
              <HeaderIcon />
              <h1 className="text-3xl font-bold text-white">Generador de Ficha de Producto AI</h1>
            </div>
            <p className="text-gray-400 mt-2">
              Transforma una foto casera en una ficha de producto profesional lista para descargar.
            </p>
          </header>

          <main>
            {error && (
              <div className="bg-red-900 border border-red-700 text-red-200 px-4 py-3 rounded-md mb-6" role="alert">
                <strong className="font-bold">Error: </strong>
                <span className="block sm:inline">{error}</span>
              </div>
            )}

            {!generatedData ? (
              <ProductForm onGenerate={handleGenerate} disabled={isLoading} />
            ) : (
              <PreviewDisplay 
                productData={generatedData.productData} 
                zipBlob={generatedData.zipBlob} 
                onReset={handleReset}
                onDeleteImage={handleDeleteImage}
                onEditImage={handleEditImage}
                onUndoImage={handleUndoImage}
                onCompareImage={handleCompareImage}
              />
            )}
          </main>
        </div>
        
        <EditImageModal
          isOpen={isEditModalOpen}
          onClose={() => setIsEditModalOpen(false)}
          onEdit={handleEditSubmit}
          onImprovePrompt={handleImprovePrompt}
          isLoading={isLoading}
        />
      </div>
    );
  };

  const container = document.getElementById("root");
  const root = ReactDOM.createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
})();
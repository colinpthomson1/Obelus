# Rebuilding the Obelus package

The package is generated from `brand_spec.json` plus three scripts:

1. `generate_identity_assets.py` creates the logo, color, typography, icon, pattern, preview, social, and application artwork.
2. `generate_motion_assets.py` creates the five motion systems and their SVG, CSS, HTML, Lottie, raster, and video outputs.
3. `build_brand_guidelines_pdf.py` creates the complete guidelines and quick-reference PDFs.
4. `qa_and_manifest.py` validates structural integrity and local links, then writes the delivery manifest and SHA-256 checksums.

Run the scripts from the repository root with Python 3. Their required libraries are listed in the import blocks. The generated files are deterministic except for PDF metadata timestamps and compressed media metadata.

Do not hand-edit generated derivatives without also updating their source specification or generator.

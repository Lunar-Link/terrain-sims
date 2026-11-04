"""Assembles index.html, a standalone static page, from src/ and the JSON in data/."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def read(*p):
    with open(os.path.join(HERE, *p), encoding="utf-8") as f:
        return f.read()


meta = json.loads(read("data", "meta.json"))
valid = read("data", "validation.json")
html = (
    "<!doctype html>\n<html lang=\"en\">\n<head>\n"
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    '<meta name="description" content="Place radio relays on the 16 km Malapert map and simulate links, coverage and data rate.">\n'
    "<title>Malapert Node Planner</title>\n"
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=B612:wght@400;700&family=Saira+Semi+Condensed:wght@600;700&display=swap">\n'
    "<style>\nbody { margin: 0; }\n[hidden] { display: none !important; }\n" + read("src", "page.css") + "</style>\n</head>\n<body>\n"
    + read("src", "page_body.html")
    + '<script id="engine-src">\n' + read("src", "engine.js") + "</script>\n<script>\nwindow.MALAPERT_META=" + json.dumps(meta, separators=(",", ":"))
    + ";\nwindow.MALAPERT_VALID=" + valid + ";\n</script>\n<script>\n" + read("src", "page.js") + "</script>\n</body>\n</html>\n"
)
with open(os.path.join(HERE, "index.html"), "w", encoding="utf-8", newline="\n") as f:
    f.write(html)
print("index.html", round(os.path.getsize(os.path.join(HERE, "index.html")) / 1e6, 3), "MB")

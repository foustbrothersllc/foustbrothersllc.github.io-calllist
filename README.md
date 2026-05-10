# Driver Call List

A mobile-friendly, click-to-call driver directory. Tap any phone number on your phone to dial it instantly.

## Features

- 📞 **Click-to-call** — every number is a `tel:` link; tap to dial
- 🔍 **Instant search** — filter by name or phone number as you type
- 📍 **Location filter** — toggle between All, Greensboro, and Mebane
- 📴 **Works offline** — no internet required after first load
- 📱 **Mobile-first** — designed for phone screens

## Project Structure

```
driver-call-list/
├── index.html     # App shell — markup only, no inline styles or scripts
├── styles.css     # All visual styling
├── app.js         # Filtering, search, and DOM rendering logic
├── drivers.json   # Driver data (name, location, phone numbers)
└── README.md
```

## How to Use

### On your phone (simplest)
1. Download all four files into the same folder
2. Open `index.html` in your mobile browser (Safari or Chrome)
3. Optionally: use your browser's **Add to Home Screen** option for quick access

### Host on GitHub Pages (recommended)
1. Push this folder to a GitHub repository
2. Go to **Settings → Pages**
3. Set source to `main` branch, `/ (root)` folder
4. Your list will be live at `https://yourusername.github.io/your-repo-name/`

### Run locally for development
Because `app.js` fetches `drivers.json` via `fetch()`, you need a local server (not just opening the file directly):

```bash
# Python 3
python3 -m http.server 8000

# Node (if you have npx)
npx serve .
```

Then open `http://localhost:8000` in your browser.

## Updating the Driver List

All driver data lives in `drivers.json`. Each entry follows this shape:

```json
{
  "lastName":  "Smith",
  "firstName": "John",
  "location":  "Greensboro",
  "phone":    { "digits": "3365551234", "display": "(336) 555-1234" },
  "altPhone": { "digits": "3365554321", "display": "(336) 555-4321 E" }
}
```

- `phone` and `altPhone` can be `null` if no number is available
- `digits` must be exactly 10 digits (no country code) — used for the `tel:` link
- `display` is shown on screen exactly as written
- Add new locations by adding entries with a new `location` value, then add a matching filter button in `index.html` and a CSS badge class in `styles.css`

## Adding a New Location

1. **`drivers.json`** — add entries with the new location string (e.g. `"Burlington"`)
2. **`index.html`** — add a filter button inside `.filter-btns`:
   ```html
   <button class="filter-btn" data-loc="burlington">Burlington</button>
   ```
3. **`styles.css`** — add a badge color class:
   ```css
   .loc-burlington { background: #fef9c3; color: #854d0e; }
   ```

## Browser Support

Works in all modern browsers: Chrome, Safari, Firefox, Edge. Requires JavaScript enabled.

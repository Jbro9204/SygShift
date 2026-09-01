(function () {
  var storageKey = 'sygshift.theme'
  var storedTheme = null

  try {
    storedTheme = window.localStorage.getItem(storageKey)
  } catch (_) {
    storedTheme = null
  }

  var theme = storedTheme === 'light' || storedTheme === 'dark'
    ? storedTheme
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme

  var themeColor = document.querySelector('meta[name="theme-color"]')
  if (themeColor) themeColor.setAttribute('content', theme === 'dark' ? '#0d1013' : '#10100f')
})()

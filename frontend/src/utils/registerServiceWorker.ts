'use client';

/**
 * Registers the service worker for offline support and caching.
 * 
 * **Production-only**: This function only registers the service worker when
 * `NODE_ENV === 'production'`. In development, it silently no-ops to avoid
 * caching interference during local testing.
 * 
 * **Error handling**: Registration errors are caught and logged but do not
 * throw, allowing the application to continue without service worker support.
 * 
 * @returns Promise that resolves to the ServiceWorkerRegistration if successful,
 *          or undefined if registration is skipped or fails.
 */
export async function registerServiceWorker() {
  if (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    process.env.NODE_ENV === 'production'
  ) {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
      });

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New service worker available, prompt user to refresh
              console.log('New service worker available');
            }
          });
        }
      });

      console.log('Service Worker registered successfully');
      return registration;
    } catch (error) {
      console.error('Service Worker registration failed:', error);
    }
  }
}

/**
 * Unregisters the currently active service worker.
 * 
 * **Fire-and-forget**: This function returns immediately without waiting for
 * the unregistration promise to resolve. The actual unregistration happens
 * asynchronously in the background.
 * 
 * Use this when you need to clear service worker state, such as during
 * development debugging or when explicitly disabling offline functionality.
 * 
 * @returns void - Does not wait for unregistration to complete.
 */
export function unregisterServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then((registration) => {
      registration.unregister();
    });
  }
}

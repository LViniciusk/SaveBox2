window.addEventListener('DOMContentLoaded', () => {
  const base = window.location.pathname.replace(/\/$/, '');
  const apiBase = base.replace(/\/api\/docs$/, '') || '/';

  window.ui = SwaggerUIBundle({
    url: `${base}/swagger.yaml`,
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
    validatorUrl: null,
    // Try it out must use the same public prefix as the documentation.
    plugins: [() => ({
      statePlugins: {
        spec: {
          wrapActions: {
            updateJsonSpec: (original) => (spec) => original({
              ...spec,
              servers: [{ url: apiBase, description: 'Current origin' }],
            }),
          },
        },
      },
    })],
  });
});

# Checklist manual de regressão

Execute em ambiente de teste, com uma conta descartável e arquivos sem conteúdo sensível.

- [X] Abrir a home do cofre e confirmar que a lista de arquivos e pastas carrega sem erro visível.
- [X] Navegar para uma pasta, voltar pelo breadcrumb e usar o botão de voltar; confirmar que o caminho e a lista permanecem consistentes.
- [X] Criar uma pasta com nome válido, validar a presença na lista e recarregar a página para confirmar persistência.
- [X] Tentar criar pasta com nome vazio ou já existente e confirmar a mensagem de erro sem item duplicado.
- [X] Enviar um arquivo pequeno, confirmar progresso, conclusão e presença na pasta atual.
- [X] Cancelar um upload em andamento e confirmar que o item não fica preso em estado de transferência.
- [X] Simular falha de rede durante upload, confirmar erro compreensível e que um novo envio pode ser iniciado.
- [X] Baixar um arquivo e confirmar que o nome e o conteúdo resultante são corretos.
- [X] Abrir mídia pública, verificar carregamento de thumbnail e reprodução quando suportada pelo navegador.
- [X] Tentar acessar link público expirado ou inválido e confirmar que não há vazamento de metadados do arquivo.
- [X] Excluir um arquivo de teste e confirmar sua remoção após recarregar a listagem.
- [X] Verificar com DevTools que dados de arquivo não aparecem em logs ou mensagens de erro em texto claro.

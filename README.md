# SaveBox 2.0

Um backend de armazenamento em nuvem de alta performance.

## Arquitetura e Recursos Principais

O SaveBox 2.0 foi construído com a filosofia de Zero-Knowledge, atuando como um gerenciador cego que armazena, divide e distribui os bytes físicos e metadados criptografados, enquanto a descriptografia ocorre exclusivamente no lado do cliente.

* **Upload e Download em Chunks:** Suporte nativo para arquivos massivos. Os arquivos são divididos em chunks para upload seguro e resumível. O download suporta *Partial Content* (Header HTTP `Range`) para streaming de vídeos e pausas em downloads.
* **Hierarquia de Arquivos Lógica:** Estrutura de árvore com pastas, subpastas, suporte a navegação recursiva e paginação.
* **Links Públicos Seguros:** Compartilhamento de arquivos via UUID v4, compatível com a arquitetura E2EE.
* **Segurança Anti-IDOR:** Todas as rotas validadas com JWT verificam a propriedade do arquivo no Banco de Dados antes de qualquer manipulação de disco.
* **Exclusão em Cascata:** Exclusão recursiva de árvores de diretórios com limpeza automática de arquivos no disco rígido.
* **Integração Google Drive:** Permite aos usuários vincularem suas contas do Google para salvar arquivos na nuvem de forma segura.

## Tecnologias Utilizadas

* **Linguagem:** C++17
* **Web Framework:** Crow
* **Banco de Dados:** PostgreSQL
* **Testes Unitários/E2E:** Catch2 v3
* **Compilação:** CMake + MinGW/UCRT64

---

## Documentação da API (Endpoints)

Todas as requisições (exceto `/health`, `/register`, `/login`, `/verify` e `/share`) exigem o Header HTTP:
`Authorization: Bearer <seu_token_jwt>`

### Autenticação e Usuário
| Método | Endpoint | Descrição |
| :--- | :--- | :--- |
| `GET` | `/health` | Healthcheck do servidor. |
| `POST` | `/register` | Registra um novo usuário. |
| `GET` | `/verify?token=<uuid>` | Valida o token recebido por e-mail e ativa a conta. |
| `POST` | `/login` | Autentica e retorna o JWT Bearer Token. |
| `GET` | `/users/me/quota` | Consulta limite e uso de armazenamento. |
| `POST` | `/api/auth/google` | Realiza login via Google. |

### Gerenciamento de Pastas
| Método | Endpoint | Descrição |
| :--- | :--- | :--- |
| `POST` | `/folders` | Cria nova pasta. |
| `GET` | `/folders/<id>/contents` | Lista subpastas e arquivos diretos de uma pasta. |
| `GET` | `/tree?file_limit=&file_offset=` | Retorna a árvore raiz do usuário com paginação. |
| `PUT` | `/folders/<id>` | Renomeia ou move a pasta para outro `parent_id`. |
| `DELETE` | `/folders/<id>` | Exclusão recursiva que apaga todo o conteudo de uma pasta. |

### Gerenciamento de Arquivos e Chunks
| Método | Endpoint | Descrição |
| :--- | :--- | :--- |
| `POST` | `/files` | Inicializa o upload (retorna o `file_id` para os chunks). |
| `POST` | `/files/<id>/chunks` | Envia um pedaço binário. Exige Header `X-Chunk-Index`. |
| `GET` | `/files/<id>/uploaded-chunks` | Retorna array com índices de chunks já salvos. |
| `GET` | `/files/<id>/download` | Baixa o arquivo. Suporta cabeçalho HTTP `Range`. |
| `PUT` | `/files/<id>` | Renomeia ou move o arquivo de pasta. |
| `DELETE` | `/files/<id>` | Deleta o arquivo físico e lógico. |
| `GET` | `/pending-uploads` | Lista uploads iniciados que ainda não foram concluídos. |

### Lixeira e Recuperação
| Método | Endpoint | Descrição |
| :--- | :--- | :--- |
| `GET` | `/trash` | Lista todos os itens deletados (Soft Deleted). |
| `POST` | `/folders/<id>/restore` | Restaura pasta (resolve colisões de nome). |
| `POST` | `/files/<id>/restore` | Restaura arquivo para local original ou raiz. |
| `DELETE` | `/trash/empty` | **Hard Delete:** Limpa a lixeira permanentemente. |

### Compartilhamento (Links Públicos)
| Método | Endpoint | Descrição |
| :--- | :--- | :--- |
| `POST` | `/files/<id>/share` | Gera e retorna um UUID v4 para acesso público. |
| `GET` | `/share/<uuid>` | Rota pública sem JWT. Retorna cabeçalho `X-Encrypted-Name`. |

### Armazenamento Externo (Google Drive)
| Método | Endpoint | Descrição |
| :--- | :--- | :--- |
| `POST` | `/api/storage/google/link` | Vincula uma conta Google. |
| `GET` | `/api/storage/google/token` | Retorna um `access_token` fresco de 1h do Google. |
| `POST` | `/files/<id>/finalize-external` | Registra no banco um upload concluído direto no Drive. |

### Documentação (Swagger)
| Método | Endpoint | Descrição |
| :--- | :--- | :--- |
| `GET` | `/api/docs` | Interface gráfica do Swagger UI. |
| `GET` | `/api/docs/swagger.yaml` | Retorna o arquivo de especificação OpenAPI puro. |

---

## Como Compilar e Rodar (Localmente)

O projeto utiliza o CMake para geração dos *build files*.

1. Crie e acesse a pasta de build:
   `mkdir build && cd build`

2. Gere os arquivos do MinGW:
   `cmake -G "MinGW Makefiles" ..`

3. Compile a bateria de testes e o servidor principal:
   `mingw32-make`

4. Execute os testes para garantir a integridade:
   `./savebox_tests.exe`

5. Inicie o Servidor:
   `./savebox_server.exe`

## Como Rodar via Docker (Recomendado)

O projeto já possui as configurações prontas de `docker-compose` para subir tanto o servidor da API quanto o banco de dados PostgreSQL simultaneamente.

1. Na pasta raiz do projeto, garanta que o seu arquivo `.env` esteja configurado corretamente.
2. Construa e suba os contêineres em background:
   ```bash
   docker-compose up -d --build
   ```
3. A API estará exposta na porta definida no arquivo.
4. Para desligar e remover os contêineres:
   ```bash
   docker-compose down
   ```
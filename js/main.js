import { FileSystemAPI } from './fileSystemAPI.js';
import * as UI from './ui.js';
import * as Chat from './chat.js';
import { Utils } from './utils.js';

// --- Application State ---
let state = {
    currentDirectory: '/',
    selectedFilePath: null,
    isEditorDirty: false,
    lastLoadedAgentConfig: null, // Store the last successfully loaded agent config
};

// --- DOM Element References ---
const getElement = (id) => document.getElementById(id);

const fileContentEditor = getElement('file-content-editor');
const saveButton = getElement('btn-save-file');
const deleteButton = getElement('btn-delete-file');
const rootButton = getElement('btn-root');
const createFileButton = getElement('btn-create-file');
// const chatMessageInput = getElement('chat-message-input'); // Removed, using fileContentEditor
const sendMessageButton = getElement('btn-send-message');
// const apiKeyInput = getElement('api-key-input'); // Removed - Key managed via secrets file

// --- Core Application Logic ---

/** Handles rendering the file list for a given directory */
async function handleRenderFileList(directory) {
    console.log(`Main: Rendering file list for ${directory}`);
    state.currentDirectory = directory;
    UI.setFileListLoading(true); // Show loading state
    UI.clearEditor(); // Clear editor when changing directory
    Chat.clearCurrentChat(); // Clear chat state when changing directory

    try {
        const items = await FileSystemAPI.listFiles(directory);
        // Pass the new handleDirectoryExpand callback
        UI.renderFileList(directory, items, handleRenderFileList, handleLoadFile, handleDirectoryExpand);
    } catch (error) {
        console.error(`Main: Error loading file list for ${directory}:`, error);
        UI.showNotification(`Error loading files: ${error}`, 'error');
        UI.setFileListLoading(false); // Ensure loading state is removed on error
        // Optionally display error in file list area
        getElement('file-list').innerHTML = '<li class="loading error">Ошибка загрузки списка</li>';
    } finally {
         // UI.setFileListLoading(false); // Loading state removed by renderFileList on success/empty
    }
}

/** Handles expanding a directory in the tree view */
async function handleDirectoryExpand(dirPath, subListElement, level) {
    console.log(`Main: Expanding directory ${dirPath} at level ${level}`);
    // Clear previous content (like loading indicator)
    subListElement.innerHTML = '';

    try {
        const items = await FileSystemAPI.listFiles(dirPath);

        if (items.length === 0) {
            subListElement.innerHTML = '<li class="empty" style="padding-left: ' + (level * 15) + 'px;">Папка пуста</li>';
            return;
        }

        // Sort items: directories first, then files, alphabetically
        items.sort((a, b) => {
            if (a.type === b.type) {
                return a.name.localeCompare(b.name);
            }
            return a.type === 'directory' ? -1 : 1;
        });

        // Manually create list items for the subdirectory, mimicking ui.js structure
        items.forEach(item => {
            const li = document.createElement('li');
            li.dataset.path = item.path;
            li.className = item.type;
            li.title = item.path;
            li.style.paddingLeft = `${level * 15}px`; // Indentation

            const icon = document.createElement('span');
            icon.className = 'item-icon';
            icon.textContent = item.type === 'directory' ? '📁' : '📄';
            li.appendChild(icon);

            const text = document.createElement('span');
            text.textContent = item.name;
            li.appendChild(text);

            if (item.type === 'directory') {
                const toggle = document.createElement('span');
                toggle.className = 'toggle';
                toggle.textContent = '▶'; // Initially collapsed
                li.insertBefore(toggle, icon);

                const nestedSubList = document.createElement('ul');
                nestedSubList.style.display = 'none';
                li.appendChild(nestedSubList);

                // Click on directory name navigates
                li.addEventListener('click', (event) => {
                    if (event.target !== toggle) {
                        handleRenderFileList(item.path); // Navigate into directory
                    }
                });

                // Click on toggle expands/collapses (recursive call)
                toggle.addEventListener('click', (event) => {
                    event.stopPropagation();
                    const isExpanded = nestedSubList.style.display === 'block';
                    if (isExpanded) {
                        nestedSubList.style.display = 'none';
                        toggle.textContent = '▶';
                    } else {
                        nestedSubList.style.display = 'block';
                        toggle.textContent = '▼';
                        // Load content only if it's empty
                        if (nestedSubList.children.length === 0) {
                             const loadingIndicator = document.createElement('li');
                             loadingIndicator.textContent = 'Загрузка...';
                             loadingIndicator.className = 'loading-subdir';
                             loadingIndicator.style.paddingLeft = `${(level + 1) * 15}px`;
                             nestedSubList.appendChild(loadingIndicator);
                             // Recursively call expand handler for sub-subdirectories
                             handleDirectoryExpand(item.path, nestedSubList, level + 1);
                        }
                    }
                });
            } else { // File
                li.addEventListener('click', () => handleLoadFile(item.path));
            }
            subListElement.appendChild(li);
        });

    } catch (error) {
        console.error(`Main: Error expanding directory ${dirPath}:`, error);
        UI.showNotification(`Ошибка загрузки ${dirPath}: ${error}`, 'error');
        subListElement.innerHTML = `<li class="error" style="padding-left: ${level * 15}px;">Ошибка</li>`;
    }
}


/** Handles loading a selected file into the editor and potentially chat */
async function handleLoadFile(filePath) {
    console.log(`Main: Loading file ${filePath}`);
    if (state.isEditorDirty && !confirm("Есть несохраненные изменения. Продолжить без сохранения?")) {
        return;
    }
    state.isEditorDirty = false; // Reset dirty flag
    state.selectedFilePath = filePath;

    UI.updateEditorDisplay(null); // Show loading state in editor
    UI.updateFileStatus('Загрузка...');
    Chat.clearCurrentChat(); // Clear previous chat state

    try {
        const fileData = await FileSystemAPI.getFile(filePath);
        if (fileData) {
            UI.updateEditorDisplay(fileData);
            state.selectedFilePath = fileData.filePath; // Confirm selected path

            // Specific logic based on file type/location
            const directory = Utils.getDirectory(filePath);
            const fileName = Utils.getFileName(filePath);

            if (directory === '/agents/' && fileName.endsWith('.json')) {
                try {
                    const config = JSON.parse(fileData.content);
                    // Validate basic structure
                    if (!config || typeof config !== 'object' || !config.configurations?.model) {
                         throw new Error("Invalid agent structure or missing model.");
                    }
                    Chat.setActiveAgentConfig(config); // Update chat module's agent config
                    state.lastLoadedAgentConfig = config; // Store the valid config in main state
                    UI.displayAgentConfig(config);
                    UI.showNotification(`Конфигурация агента ${config.name || fileName} загружена.`, 'success', 2000);
                } catch (e) {
                    console.error("Main: Error parsing or validating agent config:", e);
                    UI.showNotification(`Ошибка в конфигурации агента ${fileName}: ${e.message}`, 'error');
                    Chat.setActiveAgentConfig(null); // Reset agent config on error
                    // Do not update state.lastLoadedAgentConfig on error
                    UI.displayAgentConfig(null, e.message); // Show error in UI
                }
            } else {
                 UI.displayAgentConfig(null); // Hide agent config display if not an agent file
                 // Keep existing activeAgentConfig in Chat module unless explicitly changed
            }

            if (directory === '/chats/' && fileName.endsWith('.json')) {
                Chat.loadChat(fileData); // Load chat history
                // Optionally disable editor for chat files?
                // fileContentEditor.disabled = true;
            } else {
                 Chat.clearCurrentChat(); // Ensure chat is cleared if not a chat file
                 // Disable send button if not a chat file? Or allow sending to create new chat? Let's allow.
            }

            // Enable/disable buttons based on loaded file context
            UI.updateButtonStates(state.selectedFilePath, state.isEditorDirty, fileContentEditor.value.trim().length > 0);


        } else {
            UI.showNotification(`File ${filePath} not found`, 'error');
            UI.clearEditor();
            state.selectedFilePath = null;
        }
    } catch (error) {
        console.error(`Main: Error loading file ${filePath}:`, error);
        UI.showNotification(`Error loading file: ${error}`, 'error');
        UI.clearEditor();
        state.selectedFilePath = null;
    }
}

/** Handles saving the content of the editor to the current file */
async function handleSaveFile() {
    if (!state.selectedFilePath || !state.isEditorDirty) {
        UI.showNotification(state.selectedFilePath ? 'Нет изменений для сохранения' : 'Файл не выбран', 'warning', 1500);
        return;
    }
    console.log(`Main: Saving file ${state.selectedFilePath}`);
    UI.updateFileStatus('Сохранение...');
    saveButton.disabled = true; // Disable buttons during save
    deleteButton.disabled = true;

    try {
        const content = fileContentEditor.value;
        const savedFileData = await FileSystemAPI.saveFile(state.selectedFilePath, content);

        UI.showNotification(`Файл ${Utils.getFileName(state.selectedFilePath)} сохранен.`, 'success');
        UI.updateFileStatus(`Сохранено: ${Utils.formatTimestamp(savedFileData.timestamp)}`);
        // Update editor info with new timestamp, keep content as is
        UI.updateEditorDisplay(savedFileData);
        state.isEditorDirty = false;
        saveButton.disabled = true; // Re-disable save button after successful save

        // Post-save actions based on file type
        const directory = Utils.getDirectory(savedFileData.filePath);
        if (directory === '/agents/' && savedFileData.name.endsWith('.json')) {
             try {
                const config = JSON.parse(savedFileData.content);
                Chat.setActiveAgentConfig(config);
                UI.displayAgentConfig(config); // Update display
            } catch (e) {
                 console.error("Main: Error parsing agent config after save:", e);
                 UI.showNotification(`Ошибка в сохраненной конфигурации агента: ${e}`, 'error');
                 Chat.setActiveAgentConfig(null);
                 UI.displayAgentConfig(null, e.message);
            }
         }
         // Reload logic for core files (requires manual refresh OR download/replace)
         if (directory === '/js/' && savedFileData.name.endsWith('.js')) {
             // Trigger download for JS files edited in the virtual /js/ directory
             try {
                 const blob = new Blob([content], { type: 'text/javascript' });
                 const url = URL.createObjectURL(blob);
                 const a = document.createElement('a');
                 a.href = url;
                 a.download = savedFileData.name; // Use the original filename
                 document.body.appendChild(a);
                 a.click();
                 document.body.removeChild(a);
                 URL.revokeObjectURL(url);
                 UI.showNotification(`Файл ${savedFileData.name} подготовлен к скачиванию. Сохраните его поверх оригинального файла в папке 'js/' и перезагрузите приложение (F5).`, 'info', 8000);
             } catch (downloadError) {
                 console.error("Main: Error triggering download:", downloadError);
                 UI.showNotification(`Ошибка при попытке скачивания файла ${savedFileData.name}. Изменения сохранены только в виртуальной системе.`, 'error');
                 // Still show the refresh warning even if download fails
                 UI.showNotification('Изменения кода сохранены (в вирт. системе). Перезагрузите приложение (F5) для применения.', 'warning', 5000);
             }
         } else if (['/core/', '/api/', '/utils/'].includes(directory) && savedFileData.name.endsWith('.js')) {
             // For other potential JS directories (if added later), just show the refresh warning
             UI.showNotification('Изменения кода сохранены (в вирт. системе). Перезагрузите приложение (F5) для применения.', 'warning', 5000);
         }
         // If a chat file was edited manually and saved, reload chat state
        if (directory === '/chats/' && savedFileData.name.endsWith('.json')) {
            Chat.loadChat(savedFileData);
        }


    } catch (error) {
        console.error(`Main: Error saving file ${state.selectedFilePath}:`, error);
        UI.showNotification(`Error saving file: ${error}`, 'error');
        UI.updateFileStatus('Ошибка сохранения');
    } finally {
        // Re-enable buttons based on state
        UI.updateButtonStates(state.selectedFilePath, state.isEditorDirty, fileContentEditor.value.trim().length > 0);
    }
}

/** Handles deleting the currently selected file */
async function handleDeleteFile() {
    if (!state.selectedFilePath) return;

    const fileName = Utils.getFileName(state.selectedFilePath);
    const backupMessage = Utils.getDirectory(state.selectedFilePath) === '/backup/'
        ? 'Резервная копия НЕ будет создана для файла из /backup/.'
        : 'Будет создана резервная копия (если возможно).';

    if (!confirm(`Вы уверены, что хотите удалить "${fileName}"?\n${backupMessage}`)) {
        return;
    }

    console.log(`Main: Deleting file ${state.selectedFilePath}`);
    UI.updateFileStatus('Удаление...');
    saveButton.disabled = true;
    deleteButton.disabled = true;
    const dirToRefresh = state.currentDirectory; // Remember directory before clearing state

    try {
        await FileSystemAPI.deleteFile(state.selectedFilePath);
        UI.showNotification(`Файл "${fileName}" удален.`, 'success');
        UI.clearEditor();
        Chat.clearCurrentChat();
        state.selectedFilePath = null;
        state.isEditorDirty = false;
        await handleRenderFileList(dirToRefresh); // Refresh file list in the current directory
    } catch (error) {
        console.error(`Main: Error deleting file ${state.selectedFilePath}:`, error);
        UI.showNotification(`Error deleting file: ${error}`, 'error');
        UI.updateFileStatus('Ошибка удаления');
        // Re-enable buttons based on state if deletion failed
        UI.updateButtonStates(state.selectedFilePath, state.isEditorDirty, fileContentEditor.value.trim().length > 0);
    }
}

/** Handles creating a new file in the current directory */
async function handleCreateFile() {
    if (state.currentDirectory === '/backup/') {
        UI.showNotification('Нельзя создавать файлы в папке /backup/', 'error');
        return;
    }

    const fileName = prompt(`Введите имя нового файла в ${state.currentDirectory}\n(например: my_notes.txt, config.json, new_chat.json):`);
    if (!fileName || !fileName.trim()) {
        return; // User cancelled or entered empty name
    }

    const newFilePath = state.currentDirectory + fileName.trim();

    try {
        // Check if file already exists
        const existing = await FileSystemAPI.getFile(newFilePath);
        if (existing) {
            UI.showNotification(`Файл ${fileName} уже существует в этой папке.`, 'error');
            return;
        }

        // Determine initial content based on type/location
        let initialContent = '';
        if (fileName.endsWith('.json')) {
            initialContent = '{}'; // Default for JSON
            if (state.currentDirectory === '/chats/') {
                initialContent = JSON.stringify({ id: Utils.generateId(), messages: [] }, null, 2);
            } else if (state.currentDirectory === '/agents/') {
                initialContent = JSON.stringify({ id: Utils.generateId(), name: "New Agent", configurations: { model: "anthropic/claude-3-haiku" } }, null, 2);
            } else if (state.currentDirectory === '/secrets/') {
                 initialContent = JSON.stringify({ id: Utils.generateId(), service: "New Service", data: {} }, null, 2);
            }
        } else if (fileName.endsWith('.txt') || fileName.endsWith('.md')) {
            initialContent = `Новый файл: ${fileName}\n`;
        }

        console.log(`Main: Creating file ${newFilePath}`);
        await FileSystemAPI.saveFile(newFilePath, initialContent); // Use saveFile for creation
        UI.showNotification(`Файл ${fileName} создан.`, 'success');

        // Refresh file list and load the new file
        await handleRenderFileList(state.currentDirectory);
        await handleLoadFile(newFilePath);

    } catch (error) {
        console.error(`Main: Error creating file ${newFilePath}:`, error);
        UI.showNotification(`Error creating file: ${error}`, 'error');
    }
}

/** Handles sending a chat message, creating a chat file if necessary */
async function handleSendMessage() {
    const messageText = fileContentEditor.value.trim();
    // const apiKey = apiKeyInput?.value.trim() || ''; // Removed - Read from secrets file below

    if (!messageText) {
        UI.showNotification('Введите сообщение для отправки.', 'warning', 1500);
        return;
    }

    let currentChatPath = state.selectedFilePath;
    let isChatFileSelected = currentChatPath && Utils.getDirectory(currentChatPath) === '/chats/' && currentChatPath.endsWith('.json');

    try {
        // Requirement 2: Auto-create chat file if needed
        if (!isChatFileSelected) {
            console.log("Main: No chat file selected. Creating new one...");
            UI.showNotification('Создание нового файла чата...', 'info');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const newChatFileName = `chat_${timestamp}.json`;
            const newChatFilePath = `/chats/${newChatFileName}`;
            const initialChatContent = JSON.stringify({ id: Utils.generateId(), messages: [] }, null, 2);

            // Ensure /chats/ directory exists (FileSystemAPI might handle this, but good practice)
            try {
                await FileSystemAPI.createDirectory('/chats/');
            } catch (dirError) {
                 if (!dirError.message || !dirError.message.includes('already exists')) {
                    console.warn("Main: Could not ensure /chats/ directory exists:", dirError);
                    // Proceed anyway, saveFile might create it
                 }
            }

            const savedChatData = await FileSystemAPI.saveFile(newChatFilePath, initialChatContent);
            UI.showNotification(`Новый чат ${newChatFileName} создан.`, 'success', 2000);

            // Refresh file list (optional, but good for UI consistency)
            // Consider only refreshing if '/chats/' is the current view or root
            if (state.currentDirectory === '/' || state.currentDirectory === '/chats/') {
                 await handleRenderFileList(state.currentDirectory);
            }

            // Load the newly created chat (this updates state.selectedFilePath)
            await handleLoadFile(newChatFilePath);
            currentChatPath = newChatFilePath; // Update for the sendMessage call below
            isChatFileSelected = true; // It's now selected
        }

        // --- Get API Key from Secrets ---
        let apiKey = null;
        const secretsPath = '/secrets/api_keys.json';
        try {
            const secretsFile = await FileSystemAPI.getFile(secretsPath);
            const secretsData = JSON.parse(secretsFile.content);
            apiKey = secretsData?.vsegpt || null; // Get the specific key
            if (apiKey) {
                 console.log("Main: Found VseGPT API key in secrets file.");
            } else {
                 console.log("Main: VseGPT key not found in secrets file.");
            }
        } catch (error) {
            // Ignore if file doesn't exist (ENOENT), otherwise log
            if (error.code !== 'ENOENT') {
                console.warn(`Main: Error reading secrets file at ${secretsPath}:`, error);
            } else {
                 console.log("Main: Secrets file not found, API key needs to be entered.");
            }
            // apiKey remains null
        }
        // --- End Get API Key ---

        // --- Ensure Agent Config is Set ---
        let currentAgentConfig = Chat.getActiveAgentConfig();
        if (!currentAgentConfig && state.lastLoadedAgentConfig) {
             console.log("Main: No active agent config found in Chat module. Applying last loaded config.");
             Chat.setActiveAgentConfig(state.lastLoadedAgentConfig);
             currentAgentConfig = state.lastLoadedAgentConfig; // Update local variable
             UI.displayAgentConfig(currentAgentConfig); // Update UI display as well
             UI.showNotification(`Используется последняя загруженная конфигурация агента: ${currentAgentConfig.name || 'Unnamed'}`, 'info', 2500);
        } else if (!currentAgentConfig) {
             // Still no config after checking last loaded? Show error and stop.
             UI.showNotification("Please load an agent configuration first (e.g., /agents/example-agent.json).", 'error');
             return; // Stop before calling sendMessage
        }
        // --- End Ensure Agent Config ---


        // Proceed with sending the message using the now-guaranteed currentChatPath
        if (isChatFileSelected) {
            // Disable send button during processing
            sendMessageButton.disabled = true;
            UI.updateButtonStates(state.selectedFilePath, state.isEditorDirty, false); // Update UI immediately

            // Pass the potentially null apiKey to sendMessage.
            // chat.js will handle prompting if apiKey is null.
            // The agent config check is now done above, but chat.js also has a check.
            await Chat.sendMessage(messageText, apiKey, currentChatPath);

            // Clear editor only if the message was actually sent (i.e., key was provided or entered)
            // We don't get direct feedback here if prompt was cancelled, but clearing is generally safe.
            fileContentEditor.value = '';
            state.isEditorDirty = false; // Sending clears the "dirty" state for the editor in chat context
            UI.updateFileStatus('Сообщение обработано'); // More generic status
        } else {
             // This case should ideally not be reached due to auto-creation logic
             console.error("Main: handleSendMessage - Could not determine or create a chat file.");
             UI.showNotification('Не удалось определить или создать файл чата для отправки.', 'error');
        }

    } catch (error) {
        console.error("Main: Error during send message / auto-create chat:", error);
        UI.showNotification(`Ошибка отправки: ${error}`, 'error');
    } finally {
        // Re-enable send button (and others) based on current state
        UI.updateButtonStates(state.selectedFilePath, state.isEditorDirty, fileContentEditor.value.trim().length > 0);
    }
}


/** Marks editor as dirty and enables relevant buttons */
function handleEditorInput() {
    const hasContent = fileContentEditor.value.trim().length > 0;
    const isFileSelected = !!state.selectedFilePath;
    const isChatFile = isFileSelected && Utils.getDirectory(state.selectedFilePath) === '/chats/';

    if (isFileSelected && !isChatFile && !state.isEditorDirty) {
        // Mark non-chat files as dirty for saving
        state.isEditorDirty = true;
        UI.updateFileStatus('Несохраненные изменения');
    } else if (isChatFile) {
        // For chat files, don't mark as "dirty" for saving, just enable send
        state.isEditorDirty = false; // Ensure save isn't accidentally enabled for chats
        UI.updateFileStatus(''); // Clear status like 'unsaved'
    }

    // Update button states based on content and context
    UI.updateButtonStates(state.selectedFilePath, state.isEditorDirty, hasContent);
}

// --- Event Listeners ---
function setupEventListeners() {
    saveButton?.addEventListener('click', handleSaveFile);
    deleteButton?.addEventListener('click', handleDeleteFile);
    fileContentEditor?.addEventListener('input', handleEditorInput); // Unified input handler
    rootButton?.addEventListener('click', () => handleRenderFileList('/'));
    createFileButton?.addEventListener('click', handleCreateFile);
    // Removed keypress listener for chat input - use button explicitly
    sendMessageButton?.addEventListener('click', handleSendMessage); // Send button handler

    // Removed API key input listener - managed via secrets file now
    // apiKeyInput?.addEventListener('change', () => { ... });
}

// --- Initialization ---
async function initialize() {
    console.log('Smart Assistant (Modular): Initializing...');
    UI.setFileListLoading(true, 'Инициализация базы данных...');
    UI.clearEditor();
    // UI.setChatInputEnabled(false); // Removed - editor is always enabled

    // Removed loading API key from localStorage
    // const savedApiKey = localStorage.getItem('vsegpt_api_key');
    // if (savedApiKey && apiKeyInput) { ... }

    try {
        await FileSystemAPI.openDB(); // Ensure DB is open and ready
        UI.showNotification('База данных готова.', 'success', 1500);

        // Load core JS files into virtual filesystem
        console.log('Main: Loading core JS files into virtual filesystem...');
        UI.setFileListLoading(true, 'Загрузка JS файлов...'); // Update loading message
        const jsFilesToLoad = [
            'chat.js',
            'dbManager.js',
            'fileSystemAPI.js',
            'main.js',
            'ui.js',
            'utils.js'
        ];
        const virtualJsDir = '/js/'; // Target directory in virtual FS

        // Ensure the target directory exists (optional, saveFile might handle it)
        try {
            // Attempt to create directory, ignore if it already exists
            await FileSystemAPI.createDirectory(virtualJsDir);
            console.log(`Main: Ensured virtual directory ${virtualJsDir} exists.`);
        } catch (dirError) {
             // Log errors other than 'already exists'
            if (!dirError.message || !dirError.message.includes('already exists')) {
                 console.warn(`Main: Could not ensure virtual directory ${virtualJsDir}:`, dirError);
            }
        }

        let allJsLoaded = true;
        for (const fileName of jsFilesToLoad) {
            const actualFilePath = `js/${fileName}`; // Path relative to index.html
            const virtualFilePath = `${virtualJsDir}${fileName}`;
            try {
                console.log(`Main: Fetching ${actualFilePath}...`);
                const response = await fetch(actualFilePath); // Fetch from server/local path
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const content = await response.text();
                console.log(`Main: Saving ${actualFilePath} to virtual path ${virtualFilePath}`);
                // Use saveFile to add/update the file in IndexedDB
                await FileSystemAPI.saveFile(virtualFilePath, content);
                console.log(`Main: Successfully loaded ${fileName} into virtual FS.`);
            } catch (error) {
                allJsLoaded = false;
                console.error(`Main: Failed to load ${fileName} into virtual FS:`, error);
                UI.showNotification(`Ошибка загрузки ${fileName}: ${error}`, 'error');
                // Continue loading other files even if one fails
            }
        }
        if (allJsLoaded) {
            console.log('Main: Finished loading core JS files.');
            UI.showNotification('JS файлы загружены в виртуальную систему.', 'info', 2000);
        } else {
             console.warn('Main: Some core JS files failed to load.');
        }
        // End loading core JS files

        setupEventListeners(); // Setup listeners after DB and JS files are ready
        await handleRenderFileList('/'); // Load root directory
    } catch (error) {
        console.error("Main: Critical initialization error:", error);
        UI.showNotification(`Критическая ошибка инициализации: ${error}. Приложение может работать некорректно.`, 'error', 0);
        UI.setFileListLoading(false);
         getElement('file-list').innerHTML = '<li class="loading error">Ошибка инициализации БД</li>';
    }
    console.log('Smart Assistant (Modular): Initialization complete.');
}

// --- Start the application ---
// Use DOMContentLoaded to ensure the DOM is ready before querying elements and initializing
document.addEventListener('DOMContentLoaded', initialize);

using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEditorMCP.Models;
using UnityEditorMCP.Helpers;
using UnityEditorMCP.Logging;
using UnityEditorMCP.Handlers;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace UnityEditorMCP.Core
{
    /// <summary>
    /// Main Unity Editor MCP class that handles TCP communication and command processing
    /// </summary>
    [InitializeOnLoad]
    public static class UnityEditorMCP
    {
        private static TcpListener tcpListener;
        private static readonly Queue<(Command command, TcpClient client)> commandQueue = new Queue<(Command, TcpClient)>();
        private static readonly object queueLock = new object();
        private static CancellationTokenSource cancellationTokenSource;
        private static Task listenerTask;
        
        private static McpStatus _status = McpStatus.NotConfigured;
        public static McpStatus Status
        {
            get => _status;
            private set
            {
                if (_status != value)
                {
                    _status = value;
                    Debug.Log($"[Unity Editor MCP] Status changed to: {value}");
                }
            }
        }
        
        public const int DEFAULT_PORT = 6400;
        private static int currentPort = DEFAULT_PORT;
        
        /// <summary>
        /// Static constructor - called when Unity loads
        /// </summary>
        static UnityEditorMCP()
        {
            Debug.Log("[Unity Editor MCP] Initializing...");
            EditorApplication.update += ProcessCommandQueue;
            EditorApplication.quitting += Shutdown;
            
            // Start the TCP listener
            StartTcpListener();
        }
        
        /// <summary>
        /// Starts the TCP listener on the configured port
        /// </summary>
        private static void StartTcpListener()
        {
            try
            {
                if (tcpListener != null)
                {
                    StopTcpListener();
                }
                
                cancellationTokenSource = new CancellationTokenSource();
                tcpListener = new TcpListener(IPAddress.Loopback, currentPort);
                tcpListener.Start();
                
                Status = McpStatus.Disconnected;
                Debug.Log($"[Unity Editor MCP] TCP listener started on port {currentPort}");
                
                // Start accepting connections asynchronously
                listenerTask = Task.Run(() => AcceptConnectionsAsync(cancellationTokenSource.Token));
            }
            catch (SocketException ex)
            {
                Status = McpStatus.Error;
                Debug.LogError($"[Unity Editor MCP] Failed to start TCP listener on port {currentPort}: {ex.Message}");
                
                if (ex.SocketErrorCode == SocketError.AddressAlreadyInUse)
                {
                    Debug.LogError($"[Unity Editor MCP] Port {currentPort} is already in use. Please ensure no other instance is running.");
                }
            }
            catch (Exception ex)
            {
                Status = McpStatus.Error;
                Debug.LogError($"[Unity Editor MCP] Unexpected error starting TCP listener: {ex}");
            }
        }
        
        /// <summary>
        /// Stops the TCP listener
        /// </summary>
        private static void StopTcpListener()
        {
            try
            {
                cancellationTokenSource?.Cancel();
                tcpListener?.Stop();
                listenerTask?.Wait(TimeSpan.FromSeconds(1));
                
                tcpListener = null;
                cancellationTokenSource = null;
                listenerTask = null;
                
                Status = McpStatus.Disconnected;
                Debug.Log("[Unity Editor MCP] TCP listener stopped");
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Unity Editor MCP] Error stopping TCP listener: {ex}");
            }
        }
        
        /// <summary>
        /// Accepts incoming TCP connections asynchronously
        /// </summary>
        private static async Task AcceptConnectionsAsync(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    var tcpClient = await AcceptClientAsync(tcpListener, cancellationToken);
                    if (tcpClient != null)
                    {
                        Status = McpStatus.Connected;
                        Debug.Log($"[Unity Editor MCP] Client connected from {tcpClient.Client.RemoteEndPoint}");
                        
                        // Handle client in a separate task
                        _ = Task.Run(() => HandleClientAsync(tcpClient, cancellationToken));
                    }
                }
                catch (ObjectDisposedException)
                {
                    // Listener was stopped
                    break;
                }
                catch (Exception ex)
                {
                    if (!cancellationToken.IsCancellationRequested)
                    {
                        Debug.LogError($"[Unity Editor MCP] Error accepting connection: {ex}");
                    }
                }
            }
        }
        
        /// <summary>
        /// Accepts a client with cancellation support
        /// </summary>
        private static async Task<TcpClient> AcceptClientAsync(TcpListener listener, CancellationToken cancellationToken)
        {
            using (cancellationToken.Register(() => listener.Stop()))
            {
                try
                {
                    return await listener.AcceptTcpClientAsync();
                }
                catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
                {
                    return null;
                }
            }
        }
        
        /// <summary>
        /// Handles communication with a connected client
        /// </summary>
        private static async Task HandleClientAsync(TcpClient client, CancellationToken cancellationToken)
        {
            try
            {
                client.ReceiveTimeout = 30000; // 30 second timeout
                client.SendTimeout = 30000;
                
                var buffer = new byte[4096];
                var stream = client.GetStream();
                var messageBuffer = new List<byte>();
                
                while (!cancellationToken.IsCancellationRequested && client.Connected)
                {
                    var bytesRead = await stream.ReadAsync(buffer, 0, buffer.Length, cancellationToken);
                    if (bytesRead == 0)
                    {
                        // Client disconnected
                        break;
                    }
                    
                    // Add received bytes to message buffer
                    for (int i = 0; i < bytesRead; i++)
                    {
                        messageBuffer.Add(buffer[i]);
                    }
                    
                    // Process complete messages
                    while (messageBuffer.Count >= 4)
                    {
                        // Read message length (first 4 bytes, big-endian)
                        var lengthBytes = messageBuffer.GetRange(0, 4).ToArray();
                        if (BitConverter.IsLittleEndian)
                        {
                            Array.Reverse(lengthBytes);
                        }
                        var messageLength = BitConverter.ToInt32(lengthBytes, 0);
                        
                        // Check if we have the complete message
                        if (messageBuffer.Count >= 4 + messageLength)
                        {
                            // Extract message
                            var messageBytes = messageBuffer.GetRange(4, messageLength).ToArray();
                            messageBuffer.RemoveRange(0, 4 + messageLength);
                            
                            var json = Encoding.UTF8.GetString(messageBytes);
                            Debug.Log($"[Unity Editor MCP] Received command (length={messageLength}): {json}");
                            
                            try
                            {
                                // Handle special ping command
                                if (json.Trim().ToLower() == "ping")
                                {
                                    var pongResponse = Response.Pong();
                                    await SendFramedMessage(stream, pongResponse, cancellationToken);
                                    continue;
                                }
                                
                                // Parse command
                                var command = JsonConvert.DeserializeObject<Command>(json);
                                if (command != null)
                                {
                                    // Queue command for processing on main thread
                                    lock (queueLock)
                                    {
                                        commandQueue.Enqueue((command, client));
                                    }
                                }
                                else
                                {
                                    var errorResponse = Response.ErrorResult("Invalid command format", "PARSE_ERROR", null);
                                    await SendFramedMessage(stream, errorResponse, cancellationToken);
                                }
                            }
                            catch (JsonException ex)
                            {
                                var errorResponse = Response.ErrorResult($"JSON parsing error: {ex.Message}", "JSON_ERROR", null);
                                await SendFramedMessage(stream, errorResponse, cancellationToken);
                            }
                        }
                        else
                        {
                            // Not enough data yet, wait for more
                            break;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                if (!cancellationToken.IsCancellationRequested)
                {
                    Debug.LogError($"[Unity Editor MCP] Client handler error: {ex}");
                }
            }
            finally
            {
                client?.Close();
                if (Status == McpStatus.Connected)
                {
                    Status = McpStatus.Disconnected;
                }
                Debug.Log("[Unity Editor MCP] Client disconnected");
            }
        }
        
        /// <summary>
        /// Sends a framed message over the stream
        /// </summary>
        private static async Task SendFramedMessage(NetworkStream stream, string message, CancellationToken cancellationToken)
        {
            var messageBytes = Encoding.UTF8.GetBytes(message);
            var lengthBytes = BitConverter.GetBytes(messageBytes.Length);
            
            // Convert to big-endian
            if (BitConverter.IsLittleEndian)
            {
                Array.Reverse(lengthBytes);
            }
            
            Debug.Log($"[Unity Editor MCP] Sending response (length={messageBytes.Length}): {message}");
            
            // Write length prefix
            await stream.WriteAsync(lengthBytes, 0, 4, cancellationToken);
            // Write message
            await stream.WriteAsync(messageBytes, 0, messageBytes.Length, cancellationToken);
            await stream.FlushAsync(cancellationToken);
        }
        
        /// <summary>
        /// Processes queued commands on the Unity main thread
        /// </summary>
        private static void ProcessCommandQueue()
        {
            lock (queueLock)
            {
                while (commandQueue.Count > 0)
                {
                    var (command, client) = commandQueue.Dequeue();
                    ProcessCommand(command, client);
                }
            }
        }
        
        /// <summary>
        /// Processes a single command
        /// </summary>
        private static async void ProcessCommand(Command command, TcpClient client)
        {
            try
            {
                Debug.Log($"[Unity Editor MCP] Processing command: {JsonConvert.SerializeObject(command)}");
                
                string response;
                
                // Handle command based on type
                switch (command.Type?.ToLower())
                {
                    case "ping":
                        var pongData = new
                        {
                            message = "pong",
                            echo = command.Parameters?["message"]?.ToString(),
                            timestamp = System.DateTime.UtcNow.ToString("o")
                        };
                        // Use new format with command ID
                        response = Response.SuccessResult(command.Id, pongData);
                        break;
                        
                    case "read_logs":
                        // Parse parameters
                        int count = 100;
                        string logTypeFilter = null;
                        
                        if (command.Parameters != null)
                        {
                            if (command.Parameters.ContainsKey("count"))
                            {
                                if (int.TryParse(command.Parameters["count"].ToString(), out int parsedCount))
                                {
                                    count = Math.Min(Math.Max(parsedCount, 1), 1000); // Clamp between 1 and 1000
                                }
                            }
                            
                            if (command.Parameters.ContainsKey("logType"))
                            {
                                logTypeFilter = command.Parameters["logType"].ToString();
                            }
                        }
                        
                        // Get logs
                        LogType? filterType = null;
                        if (!string.IsNullOrEmpty(logTypeFilter))
                        {
                            if (Enum.TryParse<LogType>(logTypeFilter, true, out LogType parsed))
                            {
                                filterType = parsed;
                            }
                        }
                        
                        var logs = LogCapture.GetLogs(count, filterType);
                        var logData = new List<object>();
                        
                        foreach (var log in logs)
                        {
                            logData.Add(new
                            {
                                message = log.message,
                                stackTrace = log.stackTrace,
                                logType = log.logType.ToString(),
                                timestamp = log.timestamp.ToString("o")
                            });
                        }
                        
                        response = Response.SuccessResult(command.Id, new
                        {
                            logs = logData,
                            count = logData.Count,
                            totalCaptured = logs.Count
                        });
                        break;
                        
                    case "clear_logs":
                        LogCapture.ClearLogs();
                        response = Response.SuccessResult(command.Id, new
                        {
                            message = "Logs cleared successfully",
                            timestamp = System.DateTime.UtcNow.ToString("o")
                        });
                        break;
                        
                    case "refresh_assets":
                        // Trigger Unity to recompile and refresh assets
                        AssetDatabase.Refresh();
                        
                        // Check if Unity is compiling
                        bool isCompiling = EditorApplication.isCompiling;
                        
                        response = Response.SuccessResult(command.Id, new
                        {
                            message = "Asset refresh triggered",
                            isCompiling = isCompiling,
                            timestamp = System.DateTime.UtcNow.ToString("o")
                        });
                        break;
                        
                    case "create_gameobject":
                        var createResult = GameObjectHandler.CreateGameObject(command.Parameters);
                        response = Response.SuccessResult(command.Id, createResult);
                        break;
                        
                    case "find_gameobject":
                        var findResult = GameObjectHandler.FindGameObjects(command.Parameters);
                        response = Response.SuccessResult(command.Id, findResult);
                        break;
                        
                    case "modify_gameobject":
                        var modifyResult = GameObjectHandler.ModifyGameObject(command.Parameters);
                        response = Response.SuccessResult(command.Id, modifyResult);
                        break;
                        
                    case "delete_gameobject":
                        var deleteResult = GameObjectHandler.DeleteGameObject(command.Parameters);
                        response = Response.SuccessResult(command.Id, deleteResult);
                        break;
                        
                    case "get_hierarchy":
                        var hierarchyResult = GameObjectHandler.GetHierarchy(command.Parameters);
                        response = Response.SuccessResult(command.Id, hierarchyResult);
                        break;
                        
                    case "create_scene":
                        var createSceneResult = SceneHandler.CreateScene(command.Parameters);
                        response = Response.SuccessResult(command.Id, createSceneResult);
                        break;
                        
                    case "load_scene":
                        var loadSceneResult = SceneHandler.LoadScene(command.Parameters);
                        response = Response.SuccessResult(command.Id, loadSceneResult);
                        break;
                        
                    case "save_scene":
                        var saveSceneResult = SceneHandler.SaveScene(command.Parameters);
                        response = Response.SuccessResult(command.Id, saveSceneResult);
                        break;
                        
                    case "list_scenes":
                        var listScenesResult = SceneHandler.ListScenes(command.Parameters);
                        response = Response.SuccessResult(command.Id, listScenesResult);
                        break;
                        
                    case "get_scene_info":
                        var getSceneInfoResult = SceneHandler.GetSceneInfo(command.Parameters);
                        response = Response.SuccessResult(command.Id, getSceneInfoResult);
                        break;
                        
                    case "get_gameobject_details":
                        var getGameObjectDetailsResult = SceneAnalysisHandler.GetGameObjectDetails(command.Parameters);
                        response = Response.SuccessResult(command.Id, getGameObjectDetailsResult);
                        break;
                        
                    case "analyze_scene_contents":
                        var analyzeSceneResult = SceneAnalysisHandler.AnalyzeSceneContents(command.Parameters);
                        response = Response.SuccessResult(command.Id, analyzeSceneResult);
                        break;
                        
                    case "get_component_values":
                        var getComponentValuesResult = SceneAnalysisHandler.GetComponentValues(command.Parameters);
                        response = Response.SuccessResult(command.Id, getComponentValuesResult);
                        break;
                        
                    case "find_by_component":
                        var findByComponentResult = SceneAnalysisHandler.FindByComponent(command.Parameters);
                        response = Response.SuccessResult(command.Id, findByComponentResult);
                        break;
                        
                    case "get_object_references":
                        var getObjectReferencesResult = SceneAnalysisHandler.GetObjectReferences(command.Parameters);
                        response = Response.SuccessResult(command.Id, getObjectReferencesResult);
                        break;
                        
                    // Play Mode Control commands
                    case "play_game":
                        var playResult = PlayModeHandler.HandleCommand("play_game", command.Parameters);
                        response = Response.SuccessResult(command.Id, playResult);
                        break;
                        
                    case "pause_game":
                        var pauseResult = PlayModeHandler.HandleCommand("pause_game", command.Parameters);
                        response = Response.SuccessResult(command.Id, pauseResult);
                        break;
                        
                    case "stop_game":
                        var stopResult = PlayModeHandler.HandleCommand("stop_game", command.Parameters);
                        response = Response.SuccessResult(command.Id, stopResult);
                        break;
                        
                    case "get_editor_state":
                        var stateResult = PlayModeHandler.HandleCommand("get_editor_state", command.Parameters);
                        response = Response.SuccessResult(command.Id, stateResult);
                        break;
                        
                    // UI Interaction commands
                    case "find_ui_elements":
                        var findUIResult = UIInteractionHandler.FindUIElements(command.Parameters);
                        response = Response.SuccessResult(command.Id, findUIResult);
                        break;
                        
                    case "click_ui_element":
                        var clickUIResult = UIInteractionHandler.ClickUIElement(command.Parameters);
                        response = Response.SuccessResult(command.Id, clickUIResult);
                        break;
                        
                    case "get_ui_element_state":
                        var getUIStateResult = UIInteractionHandler.GetUIElementState(command.Parameters);
                        response = Response.SuccessResult(command.Id, getUIStateResult);
                        break;
                        
                    case "set_ui_element_value":
                        var setUIValueResult = UIInteractionHandler.SetUIElementValue(command.Parameters);
                        response = Response.SuccessResult(command.Id, setUIValueResult);
                        break;
                        
                    case "simulate_ui_input":
                        var simulateUIResult = UIInteractionHandler.SimulateUIInput(command.Parameters);
                        response = Response.SuccessResult(command.Id, simulateUIResult);
                        break;
                        
                    // Asset Management commands
                    case "create_prefab":
                        var createPrefabResult = AssetManagementHandler.CreatePrefab(command.Parameters);
                        response = Response.SuccessResult(command.Id, createPrefabResult);
                        break;
                        
                    case "modify_prefab":
                        var modifyPrefabResult = AssetManagementHandler.ModifyPrefab(command.Parameters);
                        response = Response.SuccessResult(command.Id, modifyPrefabResult);
                        break;
                        
                    case "instantiate_prefab":
                        var instantiatePrefabResult = AssetManagementHandler.InstantiatePrefab(command.Parameters);
                        response = Response.SuccessResult(command.Id, instantiatePrefabResult);
                        break;
                        
                    case "create_material":
                        var createMaterialResult = AssetManagementHandler.CreateMaterial(command.Parameters);
                        response = Response.SuccessResult(command.Id, createMaterialResult);
                        break;
                        
                    case "modify_material":
                        var modifyMaterialResult = AssetManagementHandler.ModifyMaterial(command.Parameters);
                        response = Response.SuccessResult(command.Id, modifyMaterialResult);
                        break;
                        
                    case "open_prefab":
                        var openPrefabResult = AssetManagementHandler.OpenPrefab(command.Parameters);
                        response = Response.SuccessResult(command.Id, openPrefabResult);
                        break;
                        
                    case "exit_prefab_mode":
                        var exitPrefabModeResult = AssetManagementHandler.ExitPrefabMode(command.Parameters);
                        response = Response.SuccessResult(command.Id, exitPrefabModeResult);
                        break;
                        
                    case "save_prefab":
                        var savePrefabResult = AssetManagementHandler.SavePrefab(command.Parameters);
                        response = Response.SuccessResult(command.Id, savePrefabResult);
                        break;
                        
                    // Script Management commands
                    case "create_script":
                        var createScriptResult = ScriptHandler.CreateScript(command.Parameters);
                        response = Response.SuccessResult(command.Id, createScriptResult);
                        break;
                        
                    case "read_script":
                        var readScriptResult = ScriptHandler.ReadScript(command.Parameters);
                        response = Response.SuccessResult(command.Id, readScriptResult);
                        break;
                        
                    case "update_script":
                        var updateScriptResult = ScriptHandler.UpdateScript(command.Parameters);
                        response = Response.SuccessResult(command.Id, updateScriptResult);
                        break;
                        
                    case "delete_script":
                        var deleteScriptResult = ScriptHandler.DeleteScript(command.Parameters);
                        response = Response.SuccessResult(command.Id, deleteScriptResult);
                        break;
                        
                    case "list_scripts":
                        var listScriptsResult = ScriptHandler.ListScripts(command.Parameters);
                        response = Response.SuccessResult(command.Id, listScriptsResult);
                        break;
                        
                    case "validate_script":
                        var validateScriptResult = ScriptHandler.ValidateScript(command.Parameters);
                        response = Response.SuccessResult(command.Id, validateScriptResult);
                        break;
                        
                    case "execute_menu_item":
                        var executeMenuResult = MenuHandler.ExecuteMenuItem(command.Parameters);
                        response = Response.SuccessResult(command.Id, executeMenuResult);
                        break;
                        
                    case "clear_console":
                        var clearConsoleResult = ConsoleHandler.ClearConsole(command.Parameters);
                        response = Response.SuccessResult(command.Id, clearConsoleResult);
                        break;
                        
                    case "enhanced_read_logs":
                        var enhancedReadLogsResult = ConsoleHandler.EnhancedReadLogs(command.Parameters);
                        response = Response.SuccessResult(command.Id, enhancedReadLogsResult);
                        break;
                        
                    // Screenshot commands
                    case "capture_screenshot":
                        var captureScreenshotResult = ScreenshotHandler.CaptureScreenshot(command.Parameters);
                        response = Response.SuccessResult(command.Id, captureScreenshotResult);
                        break;
                        
                    case "analyze_screenshot":
                        var analyzeScreenshotResult = ScreenshotHandler.AnalyzeScreenshot(command.Parameters);
                        response = Response.SuccessResult(command.Id, analyzeScreenshotResult);
                        break;
                        
                    // Component commands
                    case "add_component":
                        var addComponentResult = ComponentHandler.AddComponent(command.Parameters);
                        response = Response.SuccessResult(command.Id, addComponentResult);
                        break;
                        
                    case "remove_component":
                        var removeComponentResult = ComponentHandler.RemoveComponent(command.Parameters);
                        response = Response.SuccessResult(command.Id, removeComponentResult);
                        break;
                        
                    case "modify_component":
                        var modifyComponentResult = ComponentHandler.ModifyComponent(command.Parameters);
                        response = Response.SuccessResult(command.Id, modifyComponentResult);
                        break;
                        
                    case "list_components":
                        var listComponentsResult = ComponentHandler.ListComponents(command.Parameters);
                        response = Response.SuccessResult(command.Id, listComponentsResult);
                        break;
                        
                    // Compilation monitoring commands
                    case "start_compilation_monitoring":
                        var startMonitoringResult = CompilationHandler.StartCompilationMonitoring(command.Parameters);
                        response = Response.SuccessResult(command.Id, startMonitoringResult);
                        break;
                        
                    case "stop_compilation_monitoring":
                        var stopMonitoringResult = CompilationHandler.StopCompilationMonitoring(command.Parameters);
                        response = Response.SuccessResult(command.Id, stopMonitoringResult);
                        break;
                        
                    case "get_compilation_state":
                        var compilationStateResult = CompilationHandler.GetCompilationState(command.Parameters);
                        response = Response.SuccessResult(command.Id, compilationStateResult);
                        break;
                        
                    // Tag management commands
                    case "manage_tags":
                        var tagManagementResult = TagManagementHandler.HandleCommand(command.Parameters["action"]?.ToString(), command.Parameters);
                        response = Response.SuccessResult(command.Id, tagManagementResult);
                        break;
                        
                    // Layer management commands
                    case "manage_layers":
                        var layerManagementResult = LayerManagementHandler.HandleCommand(command.Parameters["action"]?.ToString(), command.Parameters);
                        response = Response.SuccessResult(command.Id, layerManagementResult);
                        break;
                        
                    // Selection management commands
                    case "manage_selection":
                        var selectionManagementResult = SelectionHandler.HandleCommand(command.Parameters["action"]?.ToString(), command.Parameters);
                        response = Response.SuccessResult(command.Id, selectionManagementResult);
                        break;
                        
                    // Window management commands
                    case "manage_windows":
                        var windowManagementResult = WindowManagementHandler.HandleCommand(command.Parameters["action"]?.ToString(), command.Parameters);
                        response = Response.SuccessResult(command.Id, windowManagementResult);
                        break;
                        
                    // Tool management commands
                    case "manage_tools":
                        var toolManagementResult = ToolManagementHandler.HandleCommand(command.Parameters["action"]?.ToString(), command.Parameters);
                        response = Response.SuccessResult(command.Id, toolManagementResult);
                        break;
                        
                    // Asset import settings commands
                    case "manage_asset_import_settings":
                        var assetImportSettingsResult = AssetImportSettingsHandler.HandleCommand(command.Parameters["action"]?.ToString(), command.Parameters);
                        response = Response.SuccessResult(command.Id, assetImportSettingsResult);
                        break;
                        
                    // Asset database commands
                    case "manage_asset_database":
                        var assetDatabaseResult = AssetDatabaseHandler.HandleCommand(command.Parameters["action"]?.ToString(), command.Parameters);
                        response = Response.SuccessResult(command.Id, assetDatabaseResult);
                        break;
                        
                    // Asset dependency analysis commands
                    case "analyze_asset_dependencies":
                        var assetDependencyResult = AssetDependencyHandler.HandleCommand(command.Parameters["action"]?.ToString(), command.Parameters);
                        response = Response.SuccessResult(command.Id, assetDependencyResult);
                        break;
                        
                    default:
                        // Use new format with error details
                        response = Response.ErrorResult(
                            command.Id,
                            $"Unknown command type: {command.Type}", 
                            "UNKNOWN_COMMAND",
                            new { commandType = command.Type }
                        );
                        break;
                }
                
                // Send response
                if (client.Connected)
                {
                    await SendFramedMessage(client.GetStream(), response, CancellationToken.None);
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Unity Editor MCP] Error processing command {command}: {ex}");
                
                try
                {
                    if (client.Connected)
                    {
                        var errorResponse = Response.ErrorResult(
                            command.Id,
                            $"Internal error: {ex.Message}", 
                            "INTERNAL_ERROR",
                            new { 
                                commandType = command.Type,
                                stackTrace = ex.StackTrace
                            }
                        );
                        await SendFramedMessage(client.GetStream(), errorResponse, CancellationToken.None);
                    }
                }
                catch
                {
                    // Best effort - ignore errors when sending error response
                }
            }
        }
        
        /// <summary>
        /// Shuts down the MCP system
        /// </summary>
        private static void Shutdown()
        {
            Debug.Log("[Unity Editor MCP] Shutting down...");
            StopTcpListener();
            EditorApplication.update -= ProcessCommandQueue;
            EditorApplication.quitting -= Shutdown;
        }
        
        /// <summary>
        /// Restarts the TCP listener
        /// </summary>
        public static void Restart()
        {
            Debug.Log("[Unity Editor MCP] Restarting...");
            StopTcpListener();
            StartTcpListener();
        }
        
        /// <summary>
        /// Changes the listening port and restarts
        /// </summary>
        public static void ChangePort(int newPort)
        {
            if (newPort < 1024 || newPort > 65535)
            {
                Debug.LogError($"[Unity Editor MCP] Invalid port number: {newPort}. Must be between 1024 and 65535.");
                return;
            }
            
            currentPort = newPort;
            Restart();
        }
    }
}
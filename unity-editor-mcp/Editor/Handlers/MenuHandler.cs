using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace UnityEditorMCP.Handlers
{
    /// <summary>
    /// Handles Unity Editor menu item execution commands
    /// </summary>
    public static class MenuHandler
    {
        // Blacklist of dangerous menu items for safety
        // Includes dialog-opening menus that cause MCP hanging
        private static readonly HashSet<string> BlacklistedMenus = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            // Application control
            "File/Quit",
            
            // Dialog-opening file operations (cause MCP hanging)
            "File/Open Scene",
            "File/New Scene",
            "File/Save Scene As...",
            "File/Build Settings...",
            "File/Build And Run",
            
            // Dialog-opening asset operations (cause MCP hanging)
            "Assets/Import New Asset...",
            "Assets/Import Package/Custom Package...",
            "Assets/Export Package...",
            "Assets/Delete",
            
            // Dialog-opening preferences and settings (cause MCP hanging)
            "Edit/Preferences...",
            "Edit/Project Settings...",
            
            // Dialog-opening window operations (may cause issues)
            "Window/Package Manager",
            "Window/Asset Store",
            
            // Scene view operations that may require focus (potential hanging)
            "GameObject/Align With View",
            "GameObject/Align View to Selected"
        };

        /// <summary>
        /// Executes a Unity Editor menu item
        /// </summary>
        /// <param name="parameters">Command parameters</param>
        /// <returns>Execution result</returns>
        public static object ExecuteMenuItem(JObject parameters)
        {
            try
            {
                // Extract parameters
                string action = parameters["action"]?.ToString()?.ToLower() ?? "execute";
                string menuPath = parameters["menuPath"]?.ToString();
                string alias = parameters["alias"]?.ToString();
                bool safetyCheck = parameters["safetyCheck"]?.ToObject<bool>() ?? true;
                JObject menuParameters = parameters["parameters"] as JObject;

                // Validate menu path
                if (string.IsNullOrWhiteSpace(menuPath))
                {
                    return new
                    {
                        success = false,
                        error = "menuPath is required"
                    };
                }

                // Handle different actions
                switch (action)
                {
                    case "execute":
                        return ExecuteMenuAction(menuPath, alias, safetyCheck, menuParameters);
                    
                    case "get_available_menus":
                        return GetAvailableMenus(menuParameters);
                    
                    default:
                        return new
                        {
                            success = false,
                            error = $"Unknown action: {action}. Valid actions are 'execute', 'get_available_menus'"
                        };
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MenuHandler] Error executing menu operation: {ex}");
                return new
                {
                    success = false,
                    error = $"Menu operation failed: {ex.Message}"
                };
            }
        }

        /// <summary>
        /// Executes a specific menu item
        /// </summary>
        private static object ExecuteMenuAction(string menuPath, string alias, bool safetyCheck, JObject parameters)
        {
            try
            {
                // Validate menu path format
                if (!menuPath.Contains("/") || menuPath.StartsWith("/") || menuPath.EndsWith("/"))
                {
                    return new
                    {
                        success = false,
                        error = "menuPath must be in format \"Category/MenuItem\" (e.g., \"Assets/Refresh\")"
                    };
                }

                // Check blacklist if safety is enabled
                if (safetyCheck && BlacklistedMenus.Contains(menuPath))
                {
                    return new
                    {
                        success = false,
                        error = $"Menu item is blacklisted for safety: {menuPath}. Use safetyCheck: false to override."
                    };
                }

                // Record execution start time
                var startTime = DateTime.UtcNow;

                // Execute the menu item
                bool executed = false;
                bool menuExists = true;

                try
                {
                    // Try to execute the menu item
                    executed = EditorApplication.ExecuteMenuItem(menuPath);
                    
                    if (!executed)
                    {
                        // Menu item exists but couldn't be executed (might be disabled or context-dependent)
                        Debug.LogWarning($"[MenuHandler] Menu item '{menuPath}' could not be executed - it may be disabled or context-dependent");
                    }
                }
                catch (Exception ex)
                {
                    // Menu item might not exist
                    Debug.LogWarning($"[MenuHandler] Failed to execute menu item '{menuPath}': {ex.Message}");
                    menuExists = false;
                    executed = false;
                }

                // Calculate execution time
                var executionTime = (int)(DateTime.UtcNow - startTime).TotalMilliseconds;

                // Build response
                var result = new
                {
                    success = true,
                    menuPath = menuPath,
                    executed = executed,
                    menuExists = menuExists,
                    executionTime = executionTime,
                    message = executed 
                        ? "Menu item executed successfully" 
                        : menuExists 
                            ? "Menu item found but could not be executed (may be disabled or context-dependent)"
                            : "Menu item not found or execution failed"
                };

                // Add alias if provided
                if (!string.IsNullOrEmpty(alias))
                {
                    return new
                    {
                        result.success,
                        result.menuPath,
                        result.executed,
                        result.menuExists,
                        result.executionTime,
                        result.message,
                        alias = alias
                    };
                }

                return result;
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MenuHandler] Error executing menu item '{menuPath}': {ex}");
                return new
                {
                    success = false,
                    error = $"Menu item execution failed: {ex.Message}"
                };
            }
        }

        /// <summary>
        /// Gets available Unity Editor menu items
        /// Note: This is a placeholder implementation as Unity doesn't provide a direct API
        /// to enumerate all menu items. A full implementation would require reflection
        /// or maintaining a predefined list of known menu items.
        /// </summary>
        private static object GetAvailableMenus(JObject parameters)
        {
            // Common Unity menu items (partial list for demonstration)
            var commonMenus = new List<string>
            {
                // File menu
                "File/New Scene",
                "File/Open Scene",
                "File/Save",
                "File/Save As...",
                "File/Save Project",
                
                // Edit menu
                "Edit/Undo",
                "Edit/Redo",
                "Edit/Cut",
                "Edit/Copy",
                "Edit/Paste",
                "Edit/Select All",
                
                // Assets menu
                "Assets/Create/Folder",
                "Assets/Create/C# Script",
                "Assets/Create/Material",
                "Assets/Refresh",
                "Assets/Reimport All",
                
                // GameObject menu
                "GameObject/Create Empty",
                "GameObject/3D Object/Cube",
                "GameObject/3D Object/Sphere",
                "GameObject/3D Object/Cylinder",
                "GameObject/3D Object/Plane",
                "GameObject/Light/Directional Light",
                "GameObject/Audio/Audio Source",
                "GameObject/Camera",
                
                // Window menu
                "Window/General/Console",
                "Window/General/Project",
                "Window/General/Hierarchy",
                "Window/General/Inspector",
                "Window/General/Scene",
                "Window/General/Game",
                "Window/Animation/Animation",
                "Window/Animation/Animator"
            };

            // Filter by pattern if provided
            var filter = parameters?["filter"]?.ToString();
            var filteredMenus = commonMenus;

            if (!string.IsNullOrEmpty(filter))
            {
                filteredMenus = new List<string>();
                foreach (var menu in commonMenus)
                {
                    if (menu.Contains(filter) || 
                        (filter.EndsWith("*") && menu.StartsWith(filter.TrimEnd('*'))))
                    {
                        filteredMenus.Add(menu);
                    }
                }
            }

            return new
            {
                success = true,
                availableMenus = filteredMenus,
                totalMenus = commonMenus.Count,
                filteredCount = filteredMenus.Count,
                message = filter != null 
                    ? $"Filtered menus retrieved successfully (filter: {filter})" 
                    : "Available menus retrieved successfully",
                note = "This is a partial list of common Unity menu items. Unity doesn't provide a direct API to enumerate all menu items."
            };
        }

        /// <summary>
        /// Gets the list of blacklisted menu items
        /// </summary>
        /// <returns>Array of blacklisted menu paths</returns>
        public static string[] GetBlacklistedMenus()
        {
            var result = new string[BlacklistedMenus.Count];
            BlacklistedMenus.CopyTo(result);
            return result;
        }

        /// <summary>
        /// Adds a menu item to the blacklist
        /// </summary>
        /// <param name="menuPath">Menu path to blacklist</param>
        public static void AddToBlacklist(string menuPath)
        {
            if (!string.IsNullOrEmpty(menuPath))
            {
                BlacklistedMenus.Add(menuPath);
                Debug.Log($"[MenuHandler] Added '{menuPath}' to blacklist");
            }
        }

        /// <summary>
        /// Removes a menu item from the blacklist
        /// </summary>
        /// <param name="menuPath">Menu path to remove from blacklist</param>
        public static bool RemoveFromBlacklist(string menuPath)
        {
            if (!string.IsNullOrEmpty(menuPath))
            {
                bool removed = BlacklistedMenus.Remove(menuPath);
                if (removed)
                {
                    Debug.Log($"[MenuHandler] Removed '{menuPath}' from blacklist");
                }
                return removed;
            }
            return false;
        }
    }
}
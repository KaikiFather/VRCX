// Copyright(c) 2019 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using CefSharp;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

namespace VRCX
{
    public class LogWatcher
    {
        private class LogContext
        {
            public long Length;
            public long Position;
            public string RecentWorldName;
            public string LastVideoURL;
            public bool ShaderKeywordsLimitReached = false;
        }

        public static readonly LogWatcher Instance;
        private readonly DirectoryInfo m_LogDirectoryInfo;
        private readonly Dictionary<string, LogContext> m_LogContextMap; // <FileName, LogContext>
        private readonly ReaderWriterLockSlim m_LogListLock;
        private readonly List<string[]> m_LogList;
        private Thread m_Thread;
        private bool m_ResetLog;
        private bool m_FirstRun = true;
        private static DateTime tillDate = DateTime.Now;
        private static bool incomingJson;
        private static string jsonChunk;
        private static string jsonDate;
        private static string photonEvent;

        // NOTE
        // FileSystemWatcher() is unreliable

        static LogWatcher()
        {
            Instance = new LogWatcher();
        }

        public LogWatcher()
        {
            var logPath = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"Low\VRChat\VRChat";
            m_LogDirectoryInfo = new DirectoryInfo(logPath);
            m_LogContextMap = new Dictionary<string, LogContext>();
            m_LogListLock = new ReaderWriterLockSlim();
            m_LogList = new List<string[]>();
            m_Thread = new Thread(ThreadLoop)
            {
                IsBackground = true
            };
        }

        internal void Init()
        {
            m_Thread.Start();
        }

        internal void Exit()
        {
            var thread = m_Thread;
            m_Thread = null;
            thread.Interrupt();
            thread.Join();
        }
        
        public void Reset()
        {
            m_ResetLog = true;
            m_Thread?.Interrupt();
        }

        public void SetDateTill(string date)
        {
            tillDate = DateTime.Parse(date);
        }

        private void ThreadLoop()
        {
            while (m_Thread != null)
            {
                Update();

                try
                {
                    Thread.Sleep(1000);
                }
                catch
                {
                    // ThreadInterruptedException
                }
            }
        }

        private void Update()
        {
            if (m_ResetLog == true)
            {
                m_FirstRun = true;
                m_ResetLog = false;
                m_LogContextMap.Clear();
                m_LogListLock.EnterWriteLock();
                try
                {
                    m_LogList.Clear();
                }
                finally
                {
                    m_LogListLock.ExitWriteLock();
                }
            }

            var deletedNameSet = new HashSet<string>(m_LogContextMap.Keys);
            m_LogDirectoryInfo.Refresh();

            if (m_LogDirectoryInfo.Exists == true)
            {
                var fileInfos = m_LogDirectoryInfo.GetFiles("output_log_*.txt", SearchOption.TopDirectoryOnly);

                // sort by creation time
                Array.Sort(fileInfos, (a, b) => a.CreationTimeUtc.CompareTo(b.CreationTimeUtc));

                foreach (var fileInfo in fileInfos)
                {
                    fileInfo.Refresh();
                    if (fileInfo.Exists == false)
                    {
                        continue;
                    }

                    if (DateTime.Compare(fileInfo.LastWriteTime, tillDate) < 0)
                    {
                        continue;
                    }

                    if (m_LogContextMap.TryGetValue(fileInfo.Name, out LogContext logContext) == true)
                    {
                        deletedNameSet.Remove(fileInfo.Name);
                    }
                    else
                    {
                        logContext = new LogContext();
                        m_LogContextMap.Add(fileInfo.Name, logContext);
                    }

                    if (logContext.Length == fileInfo.Length)
                    {
                        continue;
                    }

                    logContext.Length = fileInfo.Length;
                    ParseLog(fileInfo, logContext);
                }
            }

            foreach (var name in deletedNameSet)
            {
                m_LogContextMap.Remove(name);
            }

            m_FirstRun = false;
        }

        private void ParseLog(FileInfo fileInfo, LogContext logContext)
        {
            try
            {
                using (var stream = new FileStream(fileInfo.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 65536, FileOptions.SequentialScan))
                {
                    stream.Position = logContext.Position;
                    using (var streamReader = new StreamReader(stream, Encoding.UTF8))
                    {
                        while (true)
                        {
                            var line = streamReader.ReadLine();
                            if (line == null)
                            {
                                logContext.Position = stream.Position;
                                break;
                            }

                            if (incomingJson)
                            {
                                jsonChunk += line;
                                if (line == "}}")
                                {
                                    var data = jsonChunk.Replace("{{", "{").Replace("}}", "}");
                                    ParseLogPhotonEvent(fileInfo, data, jsonDate, photonEvent);
                                    incomingJson = false;
                                    jsonChunk = String.Empty;
                                    jsonDate = String.Empty;
                                    photonEvent = String.Empty;
                                }
                                continue;
                            }

                            // 2020.10.31 23:36:28 Log        -  [VRCFlowManagerVRC] Destination fetching: wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd
                            // 2021.02.03 10:18:58 Log        -  [ǄǄǅǅǅǄǄǅǅǄǅǅǅǅǄǄǄǅǅǄǄǅǅǅǅǄǅǅǅǅǄǄǄǄǄǅǄǅǄǄǄǅǅǄǅǅǅ] Destination fetching: wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd

                            if (line.Length <= 36 ||
                                line[31] != '-')
                            {
                                continue;
                            }

                            if (DateTime.TryParseExact(
                                line.Substring(0, 19),
                                "yyyy.MM.dd HH:mm:ss",
                                CultureInfo.InvariantCulture,
                                DateTimeStyles.AssumeLocal,
                                out DateTime lineDate
                            ))
                            {
                                if (DateTime.Compare(lineDate, tillDate) <= 0)
                                {
                                    continue;
                                }
                            }

                            var offset = 34;
                            if (line[offset] == '[')
                            {
                                if (string.Compare(line, offset, "[Network Data] OnEvent: PLAYER:  ", 0, 33, StringComparison.Ordinal) == 0)
                                {
                                    photonEvent = line.Substring(offset + 33);
                                    incomingJson = true;
                                    jsonChunk = String.Empty;
                                    jsonDate = ConvertLogTimeToISO8601(line);
                                }
                                else if (string.Compare(line, offset, "[Network Data] OnEvent: SYSTEM ", 0, 31, StringComparison.Ordinal) == 0)
                                {
                                    photonEvent = line.Substring(offset + 31);
                                    incomingJson = true;
                                    jsonChunk = String.Empty;
                                    jsonDate = ConvertLogTimeToISO8601(line);
                                }
                                else if (ParseLogOnPlayerJoinedOrLeft(fileInfo, logContext, line, offset) == true ||
                                    ParseLogLocation(fileInfo, logContext, line, offset) == true ||
                                    ParseLogLocationDestination(fileInfo, logContext, line, offset) == true ||
                                    ParseLogPortalSpawn(fileInfo, logContext, line, offset) == true ||
                                    ParseLogNotification(fileInfo, logContext, line, offset) == true ||
                                    ParseLogJoinBlocked(fileInfo, logContext, line, offset) == true ||
                                    ParseLogAvatarPedestalChange(fileInfo, logContext, line, offset) == true ||
                                    ParseLogVideoError(fileInfo, logContext, line, offset) == true ||
                                    ParseLogVideoChange(fileInfo, logContext, line, offset) == true ||
                                    ParseLogWorldVRCX(fileInfo, logContext, line, offset) == true)
                                {
                                    continue;
                                }
                            }
                            else
                            {
                                if (ParseLogShaderKeywordsLimit(fileInfo, logContext, line, offset) == true ||
                                    ParseLogSDK2VideoPlay(fileInfo, logContext, line, offset) == true)
                                {
                                    continue;
                                }
                            }
                        }
                    }
                }
            }
            catch
            {
            }
        }

        private void AppendLog(string[] item)
        {
            m_LogListLock.EnterWriteLock();
            try
            {
                if (!m_FirstRun)
                {
                    var logLine = System.Text.Json.JsonSerializer.Serialize(item);
                    if (MainForm.Instance != null && MainForm.Instance.Browser != null)
                        MainForm.Instance.Browser.ExecuteScriptAsync("$app.addGameLogEvent", logLine);
                }
                m_LogList.Add(item);
            }
            finally
            {
                m_LogListLock.ExitWriteLock();
            }
        }

        private string ConvertLogTimeToISO8601(string line)
        {
            // 2020.10.31 23:36:22

            if (DateTime.TryParseExact(
                line.Substring(0, 19),
                "yyyy.MM.dd HH:mm:ss",
                CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeLocal,
                out DateTime dt
            ) == false)
            {
                dt = DateTime.UtcNow;
            }

            return $"{dt:yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fff'Z'}";
        }

        private bool ParseLogLocation(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2020.10.31 23:36:28 Log        -  [VRCFlowManagerVRC] Destination fetching: wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd
            // 2020.10.31 23:36:28 Log        -  [VRCFlowManagerVRC] Destination set: wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd
            // 2020.10.31 23:36:31 Log        -  [RoomManager] Entering Room: VRChat Home
            // 2020.10.31 23:36:31 Log        -  [RoomManager] Joining wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd:67646~private(usr_4f76a584-9d4b-46f6-8209-8305eb683661)~nonce(D9298A536FEEEDDBB61633661A4BDAA09717C5178DEF865C4C09372FE12E09A6)
            // 2020.10.31 23:36:31 Log        -  [RoomManager] Joining or Creating Room: VRChat Home
            // 2020.10.31 23:36:31 Log        -  [RoomManager] Successfully joined room
            // 2021.02.03 10:18:58 Log        -  [ǄǄǅǅǅǄǄǅǅǄǅǅǅǅǄǄǄǅǅǄǄǅǅǅǅǄǅǅǅǅǄǄǄǄǄǅǄǅǄǄǄǅǅǄǅǅǅ] Destination fetching: wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd
            // 2021.06.23 12:02:56 Log        -  [Behaviour] Entering Room: VRChat Home

            if (string.Compare(line, offset, "[Behaviour] Entering Room: ", 0, 27, StringComparison.Ordinal) == 0)
            {
                var worldName = line.Substring(offset + 27);
                logContext.RecentWorldName = worldName;
                return true;
            }

            if (string.Compare(line, offset, "[Behaviour] Joining wrld_", 0, 25, StringComparison.Ordinal) == 0)
            {
                var location = line.Substring(offset + 20);

                AppendLog(new[]
                {
                    fileInfo.Name,
                    ConvertLogTimeToISO8601(line),
                    "location",
                    location,
                    logContext.RecentWorldName
                });

                return true;
            }

            return false;
        }

        private bool ParseLogLocationDestination(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.09.02 00:02:12 Log        -  [Behaviour] Destination set: wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd:15609~private(usr_032383a7-748c-4fb2-94e4-bcb928e5de6b)~nonce(72CC87D420C1D49AEFFBEE8824C84B2DF0E38678E840661E)
            // 2021.09.02 00:49:15 Log        -  [Behaviour] Destination fetching: wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd

            if (string.Compare(line, offset, "[Behaviour] Destination fetching: ", 0, 34, StringComparison.Ordinal) == 0)
            {
                var location = line.Substring(offset + 34);

                AppendLog(new[]
                {
                    fileInfo.Name,
                    ConvertLogTimeToISO8601(line),
                    "location-destination",
                    location
                });

                return true;
            }

            return false;
        }

        private bool ParseLogOnPlayerJoinedOrLeft(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2020.10.31 23:36:58 Log        -  [NetworkManager] OnPlayerJoined pypy
            // 2020.10.31 23:36:58 Log        -  [Player] Initialized PlayerAPI "pypy" is local
            // 2020.10.31 23:36:58 Log        -  [NetworkManager] OnPlayerJoined Rize♡
            // 2020.10.31 23:36:58 Log        -  [Player] Initialized PlayerAPI "Rize♡" is remote

            // 2020.11.01 00:07:01 Log        -  [NetworkManager] OnPlayerLeft Rize♡
            // 2020.11.01 00:07:01 Log        -  [PlayerManager] Removed player 2 / Rize♡
            // 2020.11.01 00:07:02 Log        -  [Player] Unregistering Rize♡

            // 2021.06.23 11:41:16 Log        -  [Behaviour] Initialized PlayerAPI "Natsumi-sama" is local

            if (string.Compare(line, offset, "[Behaviour] Initialized PlayerAPI \"", 0, 35, StringComparison.Ordinal) == 0)
            {
                var pos = line.LastIndexOf("\" is ");
                if (pos < 0)
                {
                    return false;
                }

                var userDisplayName = line.Substring(offset + 35, pos - (offset + 35));
                var userType = line.Substring(pos + 5);

                AppendLog(new[]
                {
                    fileInfo.Name,
                    ConvertLogTimeToISO8601(line),
                    "player-joined",
                    userDisplayName,
                    userType,
                });

                return true;
            }

            // fallback method
            /*if (string.Compare(line, offset, "OnPlayerJoined ", 0, 15, StringComparison.Ordinal) == 0)
            {
                var userDisplayName = line.Substring(offset + 15);

                AppendLog(new[]
                {
                    fileInfo.Name,
                    ConvertLogTimeToISO8601(line),
                    "player-joined",
                    userDisplayName
                });

                return true;
            }*/

            if (string.Compare(line, offset, "[Behaviour] OnPlayerLeft ", 0, 25, StringComparison.Ordinal) == 0)
            {
                var userDisplayName = line.Substring(offset + 25);

                AppendLog(new[]
                {
                    fileInfo.Name,
                    ConvertLogTimeToISO8601(line),
                    "player-left",
                    userDisplayName
                });

                return true;
            }

            return false;
        }

        private bool ParseLogPortalSpawn(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.04.06 11:25:45 Log        -  [Network Processing] RPC invoked ConfigurePortal on (Clone [1600004] Portals/PortalInternalDynamic) for Natsumi-sama
            // 2021.07.19 04:24:28 Log        -  [Behaviour] Will execute SendRPC/AlwaysBufferOne on (Clone [100004] Portals/PortalInternalDynamic) (UnityEngine.GameObject) for Natsumi-sama: S: "ConfigurePortal" I: 7 F: 0 B: 255 (local master owner)

            if (string.Compare(line, offset, "[Behaviour] Will execute SendRPC/AlwaysBufferOne on (Clone [", 0, 60, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            var pos = line.LastIndexOf("] Portals/PortalInternalDynamic) (UnityEngine.GameObject) for ");
            if (pos < 0)
            {
                return false;
            }

            var endPos = line.LastIndexOf(": S: \"ConfigurePortal\"");
            if (endPos < 0)
            {
                return false;
            }

            var data = line.Substring(pos + 62, endPos - (pos + 62));

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "portal-spawn",
                data
            });

            return true;
        }

        private bool ParseLogShaderKeywordsLimit(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.04.04 12:21:06 Error      -  Maximum number (256) of shader keywords exceeded, keyword _TOGGLESIMPLEBLUR_ON will be ignored.
            // 2021.08.20 04:20:69 Error      -  Maximum number (384) of shader global keywords exceeded, keyword _FOG_EXP2 will be ignored.

            if (logContext.ShaderKeywordsLimitReached == true)
            {
                return false;
            }

            if (string.Compare(line, offset, "Maximum number (384) of shader global keywords exceeded", 0, 55, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "event",
                "Shader Keyword Limit has been reached"
            });
            logContext.ShaderKeywordsLimitReached = true;

            return true;
        }

        private bool ParseLogJoinBlocked(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.04.07 09:34:37 Error      -  [Behaviour] Master is not sending any events! Moving to a new instance.

            if (string.Compare(line, offset, "[Behaviour] Master is not sending any events! Moving to a new instance.", 0, 71, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "event",
                "Joining instance blocked by master"
            });

            return true;
        }

        private bool ParseLogAvatarPedestalChange(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.05.07 10:48:19 Log        -  [Network Processing] RPC invoked SwitchAvatar on AvatarPedestal for User

            if (string.Compare(line, offset, "[Network Processing] RPC invoked SwitchAvatar on AvatarPedestal for ", 0, 68, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            var data = line.Substring(offset + 68);

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "event",
                $"{data} changed avatar pedestal"
            });

            return true;
        }

        private bool ParseLogVideoError(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.04.08 06:37:45 Error -  [Video Playback] ERROR: Video unavailable
            // 2021.04.08 06:40:07 Error -  [Video Playback] ERROR: Private video

            if (string.Compare(line, offset, "[Video Playback] ERROR: ", 0, 24, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            var data = line.Substring(offset + 24);

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "event",
                "VideoError: " + data
            });

            return true;
        }

        private bool ParseLogVideoChange(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2020.10.16 14:42:33 Log        -  [Video Playback] Attempting to resolve URL 'http://storage.llss.io/yUKvv_nCpj0.mp4'

            if (string.Compare(line, offset, "[Video Playback] Attempting to resolve URL '", 0, 44, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            var pos = line.LastIndexOf("'");
            if (pos < 0)
            {
                return false;
            }
            var data = line.Substring(offset + 44);
            data = data.Remove(data.Length - 1);

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "video-play",
                data
            });

            return true;
        }

        private bool ParseLogWorldVRCX(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // [VRCX] VideoPlay(PyPyDance) "https://jd.pypy.moe/api/v1/videos/-Q3pdlsQxOk.mp4",0.5338666,260.6938,"1339 : Le Freak (Random)"

            if (string.Compare(line, offset, "[VRCX] ", 0, 7, StringComparison.Ordinal) == 0)
            {
                var data = line.Substring(offset + 7);

                AppendLog(new[]
                {
                    fileInfo.Name,
                    ConvertLogTimeToISO8601(line),
                    "vrcx",
                    data
                });

                return true;
            }

            return false;
        }

        private bool ParseLogSDK2VideoPlay(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.04.23 13:12:25 Log        -  User Natsumi-sama added URL https://www.youtube.com/watch?v=dQw4w9WgXcQ

            if (string.Compare(line, offset, "User ", 0, 5, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            var pos = line.LastIndexOf(" added URL ");
            if (pos < 0)
            {
                return false;
            }

            var playerPlayer = line.Substring(offset + 5, pos - (offset + 5));
            var data = line.Substring(pos + 11);

            if (logContext.LastVideoURL == data)
            {
                return false;
            }
            logContext.LastVideoURL = data;

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "video-play",
                data,
                playerPlayer
            });

            return true;
        }

        private bool ParseLogNotification(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.01.03 05:48:58 Log        -  [API] Received Notification: < Notification from username:pypy, sender user id:usr_4f76a584-9d4b-46f6-8209-8305eb683661 to of type: friendRequest, id: not_3a8f66eb-613c-4351-bee3-9980e6b5652c, created at: 01/14/2021 15:38:40 UTC, details: {{}}, type:friendRequest, m seen:False, message: ""> received at 01/02/2021 16:48:58 UTC

            if (string.Compare(line, offset, "[API] Received Notification: <", 0, 30, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            var pos = line.LastIndexOf("> received at ");
            if (pos < 0)
            {
                return false;
            }

            var data = line.Substring(offset + 30, pos - (offset + 30));

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "notification",
                data
            });

            return true;
        }

        private void ParseLogPhotonEvent(FileInfo fileInfo, string data, string date, string photonEvent)
        {
            // 2021.09.30 04:27:11 Log        -  [Network Data] OnEvent: PLAYER:  253
            // 2021.09.30 04:27:40 Log        -  [Network Data] OnEvent: SYSTEM 255

            if (photonEvent == "1" || photonEvent == "7" || photonEvent == "8" || photonEvent == "9" || photonEvent == "210" || photonEvent == "6")
            {
                return;
            }

            AppendLog(new[]
            {
                fileInfo.Name,
                date,
                "photon-event",
                data
            });
        }

        public string[][] Get()
        {
            Update();

            if (m_ResetLog == false &&
                m_LogList.Count > 0)
            {
                m_LogListLock.EnterWriteLock();
                try
                {
                    string[][] items;

                    if (m_LogList.Count > 1000)
                    {
                        items = new string[1000][];
                        m_LogList.CopyTo(0, items, 0, 1000);
                        m_LogList.RemoveRange(0, 1000);
                    }
                    else
                    {
                        items = m_LogList.ToArray();
                        m_LogList.Clear();
                    }

                    return items;
                }
                finally
                {
                    m_LogListLock.ExitWriteLock();
                }
            }

            return new string[][] { };
        }
    }
}

﻿// Copyright(c) 2019 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using CefSharp.DevTools.Runtime;
using System;
using System.Windows.Forms;

namespace VRCX
{
    public class Program
    {
        public static string BaseDirectory { get; private set; }

        static Program()
        {
            BaseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        }

        [STAThread]
        private static void Main()
        {
            try
            {
                Run();
            }
            catch (Exception e)
            {
                MessageBox.Show(e.ToString(), "PLEASE REPORT TO PYPY", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.Exit(0);
            }
        }

        private static void Run()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            VRCXStorage.Load();
            CpuMonitor.Instance.Init();
            Discord.Instance.Init();
            SQLite.Instance.Init();
            WebApi.Instance.Init();
            LogWatcher.Instance.Init();

            CefService.Instance.Init();
            VRCXVR.Instance.Init();
            Application.Run(new MainForm());
            VRCXVR.Instance.Exit();
            CefService.Instance.Exit();

            LogWatcher.Instance.Exit();
            WebApi.Instance.Exit();
            SQLite.Instance.Exit();
            Discord.Instance.Exit();
            CpuMonitor.Instance.Exit();
            VRCXStorage.Save();
        }
    }
}

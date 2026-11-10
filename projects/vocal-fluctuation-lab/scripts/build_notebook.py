"""個人情報や実行結果を含まない、配布用Notebookを生成します。"""
import json
from pathlib import Path
import textwrap


PROJECT = Path(__file__).resolve().parents[1]


def markdown(source):
    return {"cell_type": "markdown", "metadata": {}, "source": textwrap.dedent(source).strip() + "\n"}


def code(source, title):
    return {"cell_type": "code", "metadata": {"cellView": "form"}, "execution_count": None, "outputs": [], "source": "#@title " + title + "\n" + textwrap.dedent(source).strip() + "\n"}


def build_notebook():
    cells = [
        markdown("""
        # 歌声の1/fゆらぎを調べる

        音源の区間または曲全体を選び、歌声を抽出して、**音量が時間とともにどう揺れるか**を調べます。
        MP3やWAVなどのアップロードと、YouTubeの動画URLに対応しています。
        利用できる音源を使い、抽出音や結果を公開するときは、その利用条件を確認してください。

        **まずは下の準備セルと画面を開くセルを、上から1回ずつ実行します。**
        セルの左の▶を押し、処理が終わるまで待ちます。コードを書き換える必要はありません。
        初回はライブラリやモデルの取得に時間がかかります。

        Colabでは「ランタイム → ランタイムのタイプを変更」からGPUを選べます。
        GPUを使えないときもCPUで動かせますが、歌声の抽出には長くかかることがあります。
        [詳しい操作ガイド](https://shogo-ishikawa.github.io/2026_3Q_M4Th4/vocal-fluctuation-lab/#guide)
        """),
        markdown("""
        ## 1 準備する

        このセルは公開リポジトリから、この作品に必要なコードを取得して準備します。
        音源ファイルやGoogle Driveの内容をリポジトリへ送る処理はありません。
        Colabから接続確認を求められた場合は、接続してから進めます。
        """),
        code('''
        import io
        import subprocess
        import sys
        import tempfile
        import urllib.request
        import zipfile
        from pathlib import Path

        # ZIPを解凍してローカルで使う場合は、手元の作品フォルダを優先します。
        project_candidates = [Path.cwd(), Path.cwd().parent]
        project_directory = next((path for path in project_candidates if (path / "vocal_lab").is_dir()), None)
        if project_directory is None:
            project_directory = Path(tempfile.mkdtemp(prefix="vocal-fluctuation-source-"))
            repository_archive = "https://github.com/shogo-ishikawa/2026_3Q_M4Th4/archive/refs/heads/main.zip"
            print("作品のコードを取得しています。")
            with urllib.request.urlopen(repository_archive, timeout=90) as response:
                archive_bytes = response.read(40 * 1024 * 1024 + 1)
            if len(archive_bytes) > 40 * 1024 * 1024:
                raise RuntimeError("コードの取得サイズが上限を超えました。配布ZIPをご利用ください。")
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                marker = "/projects/vocal-fluctuation-lab/"
                for member in archive.infolist():
                    if marker not in member.filename or member.is_dir():
                        continue
                    relative = Path(member.filename.split(marker, 1)[1])
                    if relative.is_absolute() or ".." in relative.parts:
                        raise RuntimeError("取得したファイルのパスを確認できません。")
                    target = project_directory / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(member))
        requirements_file = project_directory / "requirements-colab.txt"
        if not requirements_file.is_file():
            raise RuntimeError("作品の準備ファイルが見つかりません。公開版のNotebookを開き直してください。")
        print("必要なライブラリを準備しています。")
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(requirements_file)], check=True)
        if str(project_directory) not in sys.path:
            sys.path.insert(0, str(project_directory))
        print("準備ができました。次のセルを実行してください。")
        ''', "準備をする"),
        markdown("""
        ## 2 解析画面を開く

        1. 「ファイルをアップロード」から音源を1つ選ぶか、「YouTube URL」に動画URLを入れます。
        2. 「曲全体を解析」を選ぶか、元の音源の先頭から数えた「開始（秒）」「終了（秒）」を入力します。例：40秒から130秒。
        3. 「解析を始める」を押します。
        4. 元の区間と抽出した歌声を聴き比べ、結果とグラフを確かめます。
        5. 「結果ZIPを保存」で数値と図を保存します。歌声は「歌声WAVを保存」で別に保存できます。

        **最初は60〜90秒の、歌声が入っている区間を選んでください。**
        短すぎる区間、音量変化がほとんどない区間、当てはまりが弱い区間などは判定を保留します。
        YouTubeからの取得に失敗した場合は、利用できる音源ファイルをアップロードしてください。
        既に歌声だけの音源がある場合だけ「歌声だけの音源です（分離を省略）」を選びます。
        GPUのメモリー不足で失敗した場合は「処理装置」をCPUへ変えてから試せます。

        「秒数をリセット（0〜90秒）」で、区間指定を最初の状態へ戻せます。
        曲全体・区間指定ともに上限は10分です。長い曲は区間を選んでください。
        前後の無音は歌声の抽出後に自動で除きます。「無音の調整」では、しきい値や途中の無音の扱いも変えられます。
        途中の無音を除く場合は時間を短縮した音源になり、その条件が結果にも表示されます。
        """),
        code("""
        from vocal_lab.notebook_ui import launch_notebook

        lab = launch_notebook()
        """, "解析画面を開く"),
        markdown("""
        ## 3 結果を読む

        **1/fは、ゆっくりした変動と速い変動がどの割合で含まれるかを表す性質です。**
        この作品では、歌声の振幅から短い時間ごとのRMS（音の大きさの目安）を求め、
        その時間変化のパワースペクトル密度を調べます。
        初期設定では前後の無音に近い部分を除き、歌唱の途中の間（ま）は残します。
        しきい値の−40 dBは、最大RMS振幅の約1%です。
        小さい声まで除かれる場合は「無音の調整」でしきい値を下げるか、自動除去を外します。
        調整前と調整後の長さ、除いた秒数を確認し、処理前後の歌声も聴き比べてください。

        グラフの横軸は、音そのものの高さではなく、**音量が変わる速さ**です。
        1 Hzは約1秒ごとの変化、0.2 Hzは約5秒ごとの変化に対応します。
        生のPSD、周波数を対数間隔でまとめた点、その点への直線の当てはめを表示します。

        | 表示 | 読み方 |
        |---|---|
        | 傾き β | PSDを `f^β` に当てはめた値。1/fなら目安は−1です。 |
        | R² | 当てはめた直線が、まとめた点をどの程度説明するかの目安です。 |
        | 使用帯域 | 今回の区間で調べられた変動周波数の範囲です。 |
        | 判定保留 | 長さや当てはまりなどの条件が足りず、近いかどうかを決めません。 |

        判定基準は、この教材で定めた参考基準です。**1/fを証明したり、歌唱力や心地よさを判定したりするものではありません。**
        曲の構成、歌っていない時間、音量調整、分離の誤差なども結果に影響します。
        同じ歌い手の別の区間や、別の曲でも試してみましょう。
        判定に必要な60秒は、無音調整後の長さです。
        曲全体が長くても、Aメロ・サビ・間奏などで変動の性質が変わることがあります。
        全体の結果だけで決めず、区間を分けた結果とも比較してください。
        「途中の無音も除く」を選ぶと、グラフは時間短縮後の経過時間を使います。元の曲の時間変動とは解析条件が変わります。

        学生の提出コードでは、歌声波形の100〜8000 Hzのスペクトルに直線を当てはめていました。
        これは音の高さごとの強さを表す解析です。この公開版が調べる音量の時間変動とは対象が異なります。
        元の結果は制作の記録として分け、今回の比較DBには混ぜません。
        """),
        markdown("""
        ## 4 比較DBを作って使う

        初期状態には、実測済みのアーティストDBは入っていません。
        解析方法や区間が分からない数値を混ぜず、同じ方法で測った結果を蓄積します。

        1. 比較の基準にしたい音源を解析します。
        2. 「アーティスト名」「曲名」を入力し、「この結果を比較DBへ追加」を押します。
        3. 同じアーティストの別の曲や、別のアーティストの曲も同じ条件で登録します。
        4. 「比較DBを保存」でJSONを保存します。次回は「比較DBを読み込む」から選びます。
        5. 調べたい別の音源を解析すると、登録アーティストの中で特徴が近いものを表示します。

        比較するのは音量変動の特徴です。本人かどうか、声質、歌唱力の判定ではありません。
        同じ音源・区間との自己比較や、条件が異なるデータは比較から除外します。
        無音のしきい値や途中の無音の扱いも、同じ設定で比較してください。無音調整がない旧版のDBは、そのまま比較せず再解析します。
        1曲だけの登録は、その曲の影響を強く受けます。複数の曲・区間を使い、比較曲数も確認してください。

        音源やモデル、生成した結果はGitHubへ自動アップロードしません。
        Colabの実行環境が終了すると作業中のファイルは失われるため、必要なZIP・音源・DBは保存してください。
        """),
        markdown("""
        ## 5 比較候補の5曲をまとめて準備する 任意

        提出作品で調べた5曲のURLを、比較DB作成用の候補として用意しています。
        下のセルのチェックを入れて▶を押すと、取得・歌声抽出・解析を順番に実行します。
        通常の「すべてのセルを実行」では、この処理は始まりません。

        **利用できる音源であることを確認してから実行してください。**
        URLの音源を取得できない場合や解析条件を満たさない場合は、無理に登録せず、その理由を記録します。
        候補リストは実測済みDBではありません。作成されたDBに登録できた曲数と、処理結果を確認してください。
        複数曲の分離には時間がかかります。作成できたJSONを保存し、「比較DBを読み込む」から選べば、次回の取得・分離を省けます。
        """),
        code("""
        prepare_reference_database = False #@param {type:"boolean"}

        if prepare_reference_database:
            from vocal_lab.build_references import build_reference_catalogue
            from vocal_lab.notebook_ui import download_file

            reference_build = build_reference_catalogue(
                project_directory / "data" / "reference_catalogue.json",
                Path.cwd() / "vocal_reference_build",
                start_seconds=40,
                end_seconds=130,
                device=lab.device.value,
                progress=print,
                silence_config=lab._silence_config(),
            )
            for row in reference_build["report"]:
                print(row["artist"], row["track"], row["status"], row.get("message", ""))
            download_file(Path(reference_build["database_path"]))
        else:
            print("比較候補の一括処理は実行していません。準備するときはチェックを入れて実行してください。")
        """, "比較候補の5曲を準備する（任意）"),
        markdown("""
        ## 6 コードを少し変えて確かめる

        次の例は、傾きが−1からどれだけ離れているかを求める短い関数です。
        変数、関数、繰り返し、条件分岐を使っています。
        リストの値を変え、どの値が「近い」に分類されるか予想してから実行してみましょう。
        **この距離だけでは、実際の音源の1/f判定はできません。** 実際の解析では長さや当てはまりも確かめます。
        """),
        code("""
        def distance_from_one_over_f(slope):
            return abs(slope - (-1.0))

        for slope in [-0.1, -0.8, -1.0, -1.2, -2.0]:
            distance = distance_from_one_over_f(slope)
            if distance <= 0.2:
                message = "この距離だけを見れば−1に近い"
            else:
                message = "この距離だけを見れば−1から離れている"
            print(slope, distance, message)
        """, "傾きと1/fの距離を試す（任意）"),
        markdown("""
        ## 困ったとき

        - **準備に失敗する**：エラーの最後の行を確認し、接続が切れていれば接続し直して準備セルから実行します。
        - **YouTubeから取得できない**：地域制限や配信側の制限などで取得できないことがあります。利用できるMP3やWAVのアップロードを使ってください。
        - **歌声がほとんど聞こえない**：歌唱区間の開始・終了を見直します。元音源でも歌声が入っているか確かめてください。
        - **判定保留になる**：理由を読み、より長い区間で試します。保留は失敗ではなく、条件が足りないことを示します。
        - **比較結果が出ない**：有効な比較DBが必要です。同じ解析条件で別の音源を登録してください。同じ音源との自己比較は表示しません。
        - **解析に時間がかかる**：GPUを使えるか確認します。CPUの場合は短い区間で操作を確かめてから、60秒以上の区間を使います。

        [操作ガイド](https://shogo-ishikawa.github.io/2026_3Q_M4Th4/vocal-fluctuation-lab/#guide) ／
        [ソースコード](https://github.com/shogo-ishikawa/2026_3Q_M4Th4/tree/main/projects/vocal-fluctuation-lab)
        """),
    ]
    return {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}, "colab": {"provenance": []}}, "nbformat": 4, "nbformat_minor": 5}


if __name__ == "__main__":
    path = PROJECT / "notebooks" / "vocal_fluctuation_lab.ipynb"
    path.parent.mkdir(parents=True, exist_ok=True)
    notebook = build_notebook()
    for index, cell in enumerate(notebook["cells"]):
        cell["id"] = f"vocal-lab-{index:02d}"
    path.write_text(json.dumps(notebook, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(path)

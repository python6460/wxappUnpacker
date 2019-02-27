const wu = require("./wuLib.js");
const path = require("path");
const fs = require("fs");
const {VM} = require('vm2');
const cssbeautify = require('cssbeautify');
const csstree = require('css-tree');
const cheerio = require('cheerio');

function chomp_balanced(input_str, scan_start, open_char, close_char) {
    quote_chars = ['\"', '\''];
    let now = scan_start - 1;
    let depth = 0;
    let in_quote = false;
    let start = -1;
    let end = -1;
    let end_index = input_str.length - 1;
    let now_quote_char = undefined;
    let c = undefined;
    let last_char = undefined;

    let escape_char = '\\';
    while (true) {
        now += 1;
        if (now > end_index) {
            break
        }
        last_char = c;
        c = input_str[now];
        if (quote_chars.indexOf(c) > -1 && c !== open_char) {
            if (in_quote && c === now_quote_char && last_char !== escape_char) {
                in_quote = false;
                now_quote_char = undefined
            } else {
                if (!in_quote) {
                    now_quote_char = c;
                }
                in_quote = true;
            }
            continue;
        }
        if (in_quote) {
            continue;
        }

        if (open_char !== close_char) {
            if (c === open_char) {
                depth += 1;
                if (start === -1) {
                    start = now
                }
                // let left = input_str.substr(now);
                // console.log(left);
            } else if (c === close_char) {
                depth -= 1;
                if (depth === 0) {
                    end = now;
                    break;
                }
            }

        } else {
            //开闭相同的时候,相同即可退出
            if (c === open_char) {
                depth += 1;
                if (start === -1) {
                    start = now
                }
                if (depth === 2) {
                    // 开闭相同，这个时候就满足条件了
                    end = now;
                    break
                }
            }
        }
    }
    if (start >= 0 && end > 0) {
        return {
            start: start,
            end: end
        }

    }
    return undefined;
}

function doWxss(dir, cb) {
    function GwxCfg() {
    }

    GwxCfg.prototype = {
        $gwx() {
        }
    };
    for (let i = 0; i < 300; i++) GwxCfg.prototype["$gwx" + i] = GwxCfg.prototype.$gwx;
    let runList = {}, pureData = {}, result = {}, actualPure = {}, importCnt = {}, frameName = "", onlyTest = true,
        blockCss = [];//custom block css file which won't be imported by others.(no extension name)
    function cssRebuild(data) {//need to bind this as {cssFile:__name__} before call
        let cssFile;

        function statistic(data) {
            function addStat(id) {
                if (!importCnt[id]) importCnt[id] = 1, statistic(pureData[id]);
                else ++importCnt[id];
            }

            if (typeof data === "number") return addStat(data);
            for (let content of data) if (typeof content === "object" && content[0] == 2) addStat(content[1]);
        }

        function makeup(data) {
            var isPure = typeof data === "number";
            if (onlyTest) {
                statistic(data);
                if (!isPure) {
                    if (data.length == 1 && data[0][0] == 2) data = data[0][1];
                    else return "";
                }
                if (!actualPure[data] && !blockCss.includes(wu.changeExt(wu.toDir(cssFile, frameName), ""))) {
                    console.log("Regard " + cssFile + " as pure import file.");
                    actualPure[data] = cssFile;
                }
                return "";
            }
            let res = [], attach = "";
            if (isPure && actualPure[data] != cssFile) {
                if (actualPure[data]) return '@import "' + wu.changeExt(wu.toDir(actualPure[data], cssFile), ".wxss") + '";\n';
                else {
                    res.push("/*! Import by _C[" + data + "], whose real path we cannot found. */");
                    attach = "/*! Import end */";
                }
            }
            let exactData = isPure ? pureData[data] : data;
            for (let content of exactData)
                if (typeof content === "object") {
                    switch (content[0]) {
                        case 0://rpx
                            res.push(content[1] + "rpx");
                            break;
                        case 1://add suffix, ignore it for restoring correct!
                            break;
                        case 2://import
                            res.push(makeup(content[1]));
                            break;
                    }
                } else res.push(content);
            return res.join("") + attach;
        }

        return () => {
            cssFile = this.cssFile;
            if (!result[cssFile]) result[cssFile] = "";
            result[cssFile] += makeup(data);
        };
    }

    function runVM(name, code) {
        let wxAppCode = {}, handle = {cssFile: name};
        let vm = new VM({
            sandbox: Object.assign(new GwxCfg(), {
                __wxAppCode__: wxAppCode,
                setCssToHead: cssRebuild.bind(handle)
            })
        });
        vm.run(code);
        for (let name in wxAppCode) if (name.endsWith(".wxss")) {
            handle.cssFile = path.resolve(frameName, "..", name);
            wxAppCode[name]();
        }
    }

    function preRun(dir, frameFile, mainCode, files, cb) {
        wu.addIO(cb);
        runList[path.resolve(dir, "./app.wxss")] = mainCode;
        for (let name of files) if (name != frameFile) {
            wu.get(name, code => {
                code = code.slice(0, code.indexOf("\n"));
                if (code.indexOf("setCssToHead") > -1) runList[name] = code.slice(code.indexOf("setCssToHead"));
            });
        }
    }

    function runOnce() {
        for (let name in runList) runVM(name, runList[name]);
    }

    function transformCss(style) {
        let ast = csstree.parse(style);
        csstree.walk(ast, function (node) {
            if (node.type == "Comment") {//Change the comment because the limit of css-tree
                node.type = "Raw";
                node.value = "\n/*" + node.value + "*/\n";
            }
            if (node.type == "TypeSelector") {
                if (node.name.startsWith("wx-")) node.name = node.name.slice(3);
                else if (node.name == "body") node.name = "page";
            }
            if (node.children) {
                const removeType = ["webkit", "moz", "ms", "o"];
                let list = {};
                node.children.each((son, item) => {
                    if (son.type == "Declaration") {
                        if (list[son.property]) {
                            let a = item, b = list[son.property], x = son, y = b.data, ans = null;
                            if (x.value.type == 'Raw' && x.value.value.startsWith("progid:DXImageTransform")) {
                                node.children.remove(a);
                                ans = b;
                            } else if (y.value.type == 'Raw' && y.value.value.startsWith("progid:DXImageTransform")) {
                                node.children.remove(b);
                                ans = a;
                            } else {
                                let xValue = x.value.children && x.value.children.head && x.value.children.head.data.name,
                                    yValue = y.value.children && y.value.children.head && y.value.children.head.data.name;
                                if (xValue && yValue) for (let type of removeType) if (xValue == `-${type}-${yValue}`) {
                                    node.children.remove(a);
                                    ans = b;
                                    break;
                                } else if (yValue == `-${type}-${xValue}`) {
                                    node.children.remove(b);
                                    ans = a;
                                    break;
                                } else {
                                    let mValue = `-${type}-`;
                                    if (xValue.startsWith(mValue)) xValue = xValue.slice(mValue.length);
                                    if (yValue.startsWith(mValue)) yValue = yValue.slice(mValue.length);
                                }
                                if (ans === null) ans = b;
                            }
                            list[son.property] = ans;
                        } else list[son.property] = item;
                    }
                });
                for (let name in list) if (!name.startsWith('-'))
                    for (let type of removeType) {
                        let fullName = `-${type}-${name}`;
                        if (list[fullName]) {
                            node.children.remove(list[fullName]);
                            delete list[fullName];
                        }
                    }
            }
        });
        return cssbeautify(csstree.generate(ast), {indent: '    ', autosemicolon: true});
    }

    wu.scanDirByExt(dir, ".html", files => {
        let frameFile = "";
        if (fs.existsSync(path.resolve(dir, "page-frame.html")))
            frameFile = path.resolve(dir, "page-frame.html");
        else if (fs.existsSync(path.resolve(dir, "app-wxss.js")))
            frameFile = path.resolve(dir, "app-wxss.js");
        else if (fs.existsSync(path.resolve(dir, "page-frame.js")))
            frameFile = path.resolve(dir, "page-frame.js");
        else throw Error("page-frame-like file is not found in the package by auto.");
        wu.get(frameFile, code => {

            let scriptCode = code;
            //extract script content from html
            if (frameFile.endsWith(".html")) {
                try {
                    const $ = cheerio.load(code);
                    scriptCode = [].join.apply($('html').find('script').map(function (item) {
                        return $(this).html();
                    }, "\n"));
                } catch (e) {
                    //ignore
                }
            }

            let window = {
                screen: {
                    width: 720,
                    height: 1028,
                    orientation: {
                        type: 'vertical'
                    }
                }
            };
            let navigator = {
                userAgent: "iPhone"
            };


            let mainCode = 'window= ' + JSON.stringify(window) +
                ';\nnavigator=' + JSON.stringify(navigator) +
                //";\ndocument=" + document +
                ";\n" + scriptCode;

            //remove setCssToHead function
            let setCssToHeadFuctionStartIndex = mainCode.indexOf("var setCssToHead = function");
            let setCssToHeadFunctionParamIndexes = chomp_balanced(mainCode, setCssToHeadFuctionStartIndex, '(', ')');
            let setCssToHeadFunctionEndIndexes = chomp_balanced(mainCode, setCssToHeadFunctionParamIndexes.end + 1, '{', '}');
            mainCode = mainCode.substr(0, setCssToHeadFuctionStartIndex) + mainCode.substr(setCssToHeadFunctionEndIndexes.end + 1);

            //remove var __wxAppCode__ = {};
            let wxAppCodeVarDeclare = "var __wxAppCode__={};";
            let wxAppCodeVarDeclareIndex = mainCode.indexOf(wxAppCodeVarDeclare);
            let wxAppCodeVarDeclareEnd = wxAppCodeVarDeclareIndex + wxAppCodeVarDeclare.length;
            mainCode = mainCode.substr(0, wxAppCodeVarDeclareIndex) + mainCode.substr(wxAppCodeVarDeclareEnd);

            code = code.slice(code.indexOf('var setCssToHead = function(file, _xcInvalid'));
            code = code.slice(code.indexOf('\nvar _C= ') + 1);
            //let oriCode=code;
            code = code.slice(0, code.indexOf('\n'));
            let vm = new VM({sandbox: {}});
            pureData = vm.run(code + "\n_C");
            //let mainCode=oriCode.slice(oriCode.indexOf("setCssToHead"),oriCode.lastIndexOf(";var __pageFrameEndTime__"));
            console.log("Guess wxss(first turn)...");
            preRun(dir, frameFile, mainCode, files, () => {
                frameName = frameFile;
                onlyTest = true;
                runOnce();
                onlyTest = false;
                console.log("Import count info: %j", importCnt);
                for (let id in pureData) if (!actualPure[id]) {
                    if (!importCnt[id]) importCnt[id] = 0;
                    if (importCnt[id] <= 1) {
                        console.log("Cannot find pure import for _C[" + id + "] which is only imported " + importCnt[id] + " times. Let importing become copying.");
                    } else {
                        let newFile = path.resolve(dir, "__wuBaseWxss__/" + id + ".wxss");
                        console.log("Cannot find pure import for _C[" + id + "], force to save it in (" + newFile + ").");
                        id = Number.parseInt(id);
                        actualPure[id] = newFile;
                        cssRebuild.call({cssFile: newFile}, id)();
                    }
                }
                console.log("Guess wxss(first turn) done.\nGenerate wxss(second turn)...");
                runOnce()
                console.log("Generate wxss(second turn) done.\nSave wxss...");
                for (let name in result) wu.save(wu.changeExt(name, ".wxss"), transformCss(result[name]));
                let delFiles = {};
                for (let name of files) delFiles[name] = 8;
                delFiles[frameFile] = 4;
                cb(delFiles);
            });
        });
    });
}

module.exports = {doWxss: doWxss};
if (require.main === module) {
    wu.commandExecute(doWxss, "Restore wxss files.\n\n<dirs...>\n\n<dirs...> restore wxss file from a unpacked directory(Have page-frame.html (or app-wxss.js) and other html file).");
}
